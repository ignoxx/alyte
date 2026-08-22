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

  var errorDescription: String? {
    switch self {
    case .unreadable: return "The local source could not be read for OCR"
    case .invalidPage: return "The requested OCR page is unavailable"
    case .imageUnavailable: return "The local source could not be rendered for OCR"
    }
  }
}

private func localPath(_ value: String) -> String {
  if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
  return value
}

private func renderedImage(path: String, pageIndex: Int, password: String?) throws -> CGImage {
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
    let size = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    let image = renderer.image { context in
      context.cgContext.saveGState()
      context.cgContext.scaleBy(x: scale, y: scale)
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
      let image = try renderedImage(path: path, pageIndex: pageIndex, password: password)
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
