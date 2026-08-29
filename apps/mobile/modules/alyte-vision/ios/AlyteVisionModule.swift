import ExpoModulesCore
import Foundation
import PDFKit
import UIKit
import Vision

let alyteVisionContractVersion = "alyte.vision.document.v3"

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
  guard let normalized = alyteValidatedRightAngleOrientation(orientation) else {
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
  guard pageIndex == 0 else { throw AlyteVisionError.invalidPage }
  guard alyteValidatedRightAngleOrientation(orientation) != nil else {
    throw AlyteVisionError.unsupportedOrientation
  }
  guard let image = UIImage(contentsOfFile: url.path), image.cgImage != nil else {
    throw AlyteVisionError.unreadable
  }
  guard let normalized = alyteNormalizedImportedImage(image),
    let rotated = alyteRotatedImportedImage(normalized, orientation: orientation),
    let normalizedCGImage = rotated.cgImage else {
    throw AlyteVisionError.imageUnavailable
  }
  return normalizedCGImage
}

public final class AlyteVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlyteVision")

    AsyncFunction("recognize") { (path: String, pageIndex: Int, orientation: Int, password: String?) async throws -> [String: Any] in
      let image = try renderedImage(path: path, pageIndex: pageIndex, orientation: orientation, password: password)
      var request = RecognizeDocumentsRequest()
      request.textRecognitionOptions.automaticallyDetectLanguage = true
      request.textRecognitionOptions.useLanguageCorrection = true
      request.textRecognitionOptions.maximumCandidateCount = 5
      let preferred = ["lt", "en", "de"].map { Locale.Language(identifier: $0) }
      request.textRecognitionOptions.recognitionLanguages = preferred.filter {
        request.supportedRecognitionLanguages.contains($0)
      }
      let documents = try await request.perform(on: image, orientation: .up)
      var observations: [[String: Any]] = []
      for (documentIndex, document) in documents.enumerated() {
        for (tableIndex, table) in document.document.tables.enumerated() {
          for (rowIndex, row) in table.rows.enumerated() {
            for (columnIndex, cell) in row.enumerated() {
              let text = cell.content.text.transcript
              guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
              observations.append(contentsOf: alyteDocumentObservations(
                id: "document-\(pageIndex)-\(documentIndex)-table-\(tableIndex)-r\(rowIndex)-c\(columnIndex)",
                text: text,
                box: cell.content.boundingRegion.boundingBox.cgRect,
                pageIndex: pageIndex,
                orientation: orientation,
                structure: ["kind": "table-cell", "tableId": "table-\(documentIndex)-\(tableIndex)", "rowIndex": rowIndex, "columnIndex": columnIndex],
                lines: cell.content.text.lines,
                words: cell.content.text.words
              ))
            }
          }
        }
        let tableBoxes = document.document.tables.map { $0.boundingRegion.boundingBox.cgRect }
        for (lineIndex, line) in document.document.text.lines.enumerated() {
          let text = line.transcript
          guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
          guard !tableBoxes.contains(where: { $0.intersects(line.boundingBox.cgRect) }) else { continue }
          observations.append(contentsOf: alyteDocumentObservations(
            id: "document-\(pageIndex)-\(documentIndex)-line-\(lineIndex)", text: text,
            box: line.boundingBox.cgRect, pageIndex: pageIndex, orientation: orientation,
            structure: ["kind": "text", "tableId": NSNull(), "rowIndex": NSNull(), "columnIndex": NSNull()],
            lines: [line],
            words: alyteWords(in: line.boundingBox.cgRect, from: document.document.text.words)
          ))
        }
      }
      return [
        "contractVersion": alyteVisionContractVersion,
        "pageIndex": pageIndex,
        "orientation": orientation,
        "observations": alyteApplyPageTokenSpanCap(observations),
      ]
    }
  }
}
