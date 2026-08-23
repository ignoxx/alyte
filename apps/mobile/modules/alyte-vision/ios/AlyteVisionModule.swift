import ExpoModulesCore
import Foundation
import PDFKit
import UIKit
import Vision

let alyteVisionContractVersion = "alyte.vision.document.v2"

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

    AsyncFunction("recognize") { (path: String, pageIndex: Int, orientation: Int, password: String?) async throws -> [String: Any] in
      let image = try renderedImage(path: path, pageIndex: pageIndex, orientation: orientation, password: password)
      var request = RecognizeDocumentsRequest()
      request.textRecognitionOptions.automaticallyDetectsLanguage = true
      let documents = try await request.perform(on: image, orientation: .up)
      var observations: [[String: Any]] = []
      for (documentIndex, document) in documents.enumerated() {
        for (tableIndex, table) in document.document.tables.enumerated() {
          for (rowIndex, row) in table.rows.enumerated() {
            for (columnIndex, cell) in row.enumerated() {
              let text = cell.content.text.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
              guard !text.isEmpty else { continue }
              observations.append(alyteDocumentObservation(
                id: "document-\(pageIndex)-\(documentIndex)-table-\(tableIndex)-r\(rowIndex)-c\(columnIndex)",
                text: text,
                box: cell.content.boundingRegion.boundingBox.cgRect,
                pageIndex: pageIndex,
                orientation: orientation,
                structure: ["kind": "table-cell", "tableId": "table-\(documentIndex)-\(tableIndex)", "rowIndex": rowIndex, "columnIndex": columnIndex]
              ))
            }
          }
        }
        if document.document.tables.isEmpty {
          for (lineIndex, line) in document.document.text.lines.enumerated() {
            let text = line.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            observations.append(alyteDocumentObservation(
              id: "document-\(pageIndex)-\(documentIndex)-line-\(lineIndex)", text: text,
              box: line.boundingBox.cgRect, pageIndex: pageIndex, orientation: orientation,
              structure: ["kind": "text", "tableId": NSNull(), "rowIndex": NSNull(), "columnIndex": NSNull()]
            ))
          }
        }
      }
      return ["contractVersion": alyteVisionContractVersion, "pageIndex": pageIndex, "orientation": orientation, "observations": observations]
    }
  }
}

private func alyteDocumentObservation(id: String, text: String, box: CGRect, pageIndex: Int, orientation: Int, structure: [String: Any]) -> [String: Any] {
        let x = max(0, min(1, box.minX))
        let y = max(0, min(1, 1 - box.maxY))
        let width = max(0.0001, min(1 - x, box.width))
        let height = max(0.0001, min(1 - y, box.height))
        return [
          "id": id, "text": text, "alternatives": [],
          "boundingBox": ["x": Double(x), "y": Double(y), "width": Double(width), "height": Double(height)],
          "pageIndex": pageIndex, "orientation": orientation, "structure": structure,
          "recognition": ["level": "accurate", "language": NSNull(), "internalConfidence": NSNull()],
        ]
}
