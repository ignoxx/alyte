import ExpoModulesCore
import Foundation
import PDFKit
import UIKit
import Vision

private let alyteVisionContractVersion = "alyte.vision.ocr.v1"

private enum AlyteVisionError: LocalizedError {
  case unreadable
  case invalidPage
  case imageUnavailable
  case unsupportedOrientation

  var errorDescription: String? {
    switch self {
    case .unreadable: return "The local source could not be read for OCR"
    case .invalidPage: return "The requested OCR page is unavailable"
    case .imageUnavailable: return "The local source could not be rendered for OCR"
    case .unsupportedOrientation: return "The source page has an unsupported orientation"
    }
  }
}

/// Rotates PDFKit's rendered page clockwise in a deterministic right-angle step; OCR never guesses
/// orientation from text. PDFKit owns the page-box transform so unusual PDF coordinate systems do
/// not silently render an empty OCR image.
func alyteRotatedPDFImage(_ image: UIImage, orientation: Int) throws -> UIImage {
  let normalized = ((orientation % 360) + 360) % 360
  guard normalized == 0 || normalized == 90 || normalized == 180 || normalized == 270 else {
    throw AlyteVisionError.unsupportedOrientation
  }
  guard normalized != 0 else { return image }
  let targetSize = normalized == 90 || normalized == 270
    ? CGSize(width: image.size.height, height: image.size.width)
    : image.size
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  return UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: targetSize))
    switch normalized {
    case 90:
      context.cgContext.translateBy(x: targetSize.width, y: 0)
      context.cgContext.rotate(by: .pi / 2)
    case 180:
      context.cgContext.translateBy(x: targetSize.width, y: targetSize.height)
      context.cgContext.rotate(by: .pi)
    case 270:
      context.cgContext.translateBy(x: 0, y: targetSize.height)
      context.cgContext.rotate(by: -.pi / 2)
    default: break
    }
    image.draw(in: CGRect(origin: .zero, size: image.size))
  }
}

private func localPath(_ value: String) -> String {
  if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
  return value
}

func renderedImage(path: String, pageIndex: Int, orientation: Int, password: String?) throws -> CGImage {
  let url = URL(fileURLWithPath: localPath(path))
  if url.pathExtension.lowercased() == "pdf" {
    guard let document = PDFDocument(url: url) else {
      throw AlyteVisionError.invalidPage
    }
    if document.isLocked {
      guard let password, !password.isEmpty, document.unlock(withPassword: password) else {
        throw AlyteVisionError.invalidPage
      }
    }
    guard let page = document.page(at: pageIndex) else { throw AlyteVisionError.invalidPage }
    let bounds = page.bounds(for: .mediaBox)
    let scale: CGFloat = 2
    let image = try alyteRotatedPDFImage(
      page.thumbnail(
        of: CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale)),
        for: .mediaBox
      ),
      orientation: orientation
    )
    guard let cgImage = image.cgImage else { throw AlyteVisionError.imageUnavailable }
    return cgImage
  }
  guard let image = UIImage(contentsOfFile: url.path), let cgImage = image.cgImage else {
    throw AlyteVisionError.unreadable
  }
  guard pageIndex == 0 else { throw AlyteVisionError.invalidPage }
  return cgImage
}

public final class AlyteVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlyteVision")

    AsyncFunction("recognize") { (path: String, pageIndex: Int, orientation: Int, password: String?) throws -> [String: Any] in
      let image = try renderedImage(path: path, pageIndex: pageIndex, orientation: orientation, password: password)
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.automaticallyDetectsLanguage = true
      let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
      try handler.perform([request])
      let observations = (request.results ?? []).enumerated().compactMap { index, observation -> [String: Any]? in
        guard let first = observation.topCandidates(5).first, !first.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let box = observation.boundingBox
        let x = max(0, min(1, box.minX))
        let y = max(0, min(1, 1 - box.maxY))
        let width = max(0.0001, min(1 - x, box.width))
        let height = max(0.0001, min(1 - y, box.height))
        return [
          "id": "vision-\(pageIndex)-\(index)",
          "text": first.string,
          "alternatives": observation.topCandidates(5).dropFirst().map(\.string),
          "boundingBox": ["x": Double(x), "y": Double(y), "width": Double(width), "height": Double(height)],
          "pageIndex": pageIndex,
          "orientation": orientation,
          "recognition": [
            "level": "accurate",
            // Vision does not expose a stable per-observation language on every supported iOS
            // build; the contract keeps this nullable rather than guessing from the text.
            "language": NSNull(),
            "internalConfidence": Double(first.confidence),
          ],
        ]
      }
      return [
        "contractVersion": alyteVisionContractVersion,
        "pageIndex": pageIndex,
        "orientation": orientation,
        "observations": observations,
      ]
    }
  }
}
