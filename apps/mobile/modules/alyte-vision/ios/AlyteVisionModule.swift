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

/// Maps PDF coordinates (origin at the lower-left) into the UIKit image coordinates used by
/// Vision (origin at the upper-left). The optional orientation rotates the resulting page
/// clockwise in a deterministic right-angle step; OCR never guesses orientation from text.
func alytePDFPageDrawingTransform(
  pageBounds: CGRect,
  scale: CGFloat,
  orientation: Int,
) throws -> (transform: CGAffineTransform, size: CGSize) {
  let normalized = ((orientation % 360) + 360) % 360
  guard normalized == 0 || normalized == 90 || normalized == 180 || normalized == 270 else {
    throw AlyteVisionError.unsupportedOrientation
  }
  let width = pageBounds.width * scale
  let height = pageBounds.height * scale
  switch normalized {
  case 0:
    return (
      CGAffineTransform(a: scale, b: 0, c: 0, d: -scale,
                        tx: -pageBounds.minX * scale, ty: pageBounds.maxY * scale),
      CGSize(width: width, height: height)
    )
  case 90:
    return (
      CGAffineTransform(a: 0, b: scale, c: scale, d: 0,
                        tx: -pageBounds.minY * scale, ty: -pageBounds.minX * scale),
      CGSize(width: height, height: width)
    )
  case 180:
    return (
      CGAffineTransform(a: -scale, b: 0, c: 0, d: scale,
                        tx: pageBounds.maxX * scale, ty: -pageBounds.minY * scale),
      CGSize(width: width, height: height)
    )
  default:
    return (
      CGAffineTransform(a: 0, b: -scale, c: -scale, d: 0,
                        tx: pageBounds.maxY * scale, ty: pageBounds.maxX * scale),
      CGSize(width: height, height: width)
    )
  }
}

private func localPath(_ value: String) -> String {
  if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
  return value
}

private func renderedImage(path: String, pageIndex: Int, orientation: Int, password: String?) throws -> CGImage {
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
    let drawing = try alytePDFPageDrawingTransform(
      pageBounds: bounds,
      scale: scale,
      orientation: orientation
    )
    let size = CGSize(width: max(1, drawing.size.width), height: max(1, drawing.size.height))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    let image = renderer.image { context in
      UIColor.white.setFill()
      context.fill(CGRect(origin: .zero, size: size))
      context.cgContext.saveGState()
      context.cgContext.concatenate(drawing.transform)
      page.draw(with: .mediaBox, to: context.cgContext)
      context.cgContext.restoreGState()
    }
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
