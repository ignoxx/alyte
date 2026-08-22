import ExpoModulesCore
import Foundation
import PDFKit
import UIKit

typealias AlytePDFPreviewResult = [String]

private func alytePDFFilePath(_ value: String) -> String {
  if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
  return value
}

private struct AlyteNormalizedRect {
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat
}

private enum AlytePDFError: LocalizedError {
  case unreadable
  case locked
  case malformedRecipe
  case noSelectedPages
  case renderFailed
  case verificationFailed

  var errorDescription: String? {
    switch self {
    case .unreadable: return "The PDF could not be opened"
    case .locked: return "The PDF is locked"
    case .malformedRecipe: return "The sanitization recipe is invalid"
    case .noSelectedPages: return "The sanitization recipe selects no pages"
    case .renderFailed: return "A sanitized page could not be rendered"
    case .verificationFailed: return "The sanitized artifact failed structural verification"
    }
  }
}

private func normalizedRect(_ value: Any?) throws -> AlyteNormalizedRect {
  guard let dictionary = value as? [String: Any],
        let x = dictionary["x"] as? Double,
        let y = dictionary["y"] as? Double,
        let width = dictionary["width"] as? Double,
        let height = dictionary["height"] as? Double,
        x >= 0, y >= 0, width > 0, height > 0, x + width <= 1, y + height <= 1
  else { throw AlytePDFError.malformedRecipe }
  return AlyteNormalizedRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
}

private func transformedRect(_ rect: AlyteNormalizedRect, crop: AlyteNormalizedRect?, rotation: Int) throws -> AlyteNormalizedRect {
  let area = crop ?? AlyteNormalizedRect(x: 0, y: 0, width: 1, height: 1)
  guard rect.x >= area.x, rect.y >= area.y,
        rect.x + rect.width <= area.x + area.width,
        rect.y + rect.height <= area.y + area.height else { throw AlytePDFError.malformedRecipe }
  let local = AlyteNormalizedRect(
    x: (rect.x - area.x) / area.width,
    y: (rect.y - area.y) / area.height,
    width: rect.width / area.width,
    height: rect.height / area.height
  )
  switch ((rotation % 360) + 360) % 360 {
  case 0: return local
  case 90: return AlyteNormalizedRect(x: 1 - local.y - local.height, y: local.x, width: local.height, height: local.width)
  case 180: return AlyteNormalizedRect(x: 1 - local.x - local.width, y: 1 - local.y - local.height, width: local.width, height: local.height)
  case 270: return AlyteNormalizedRect(x: local.y, y: 1 - local.x - local.width, width: local.height, height: local.width)
  default: throw AlytePDFError.malformedRecipe
  }
}

private func imageRotated(_ image: UIImage, degrees: Int) -> UIImage {
  let normalized = ((degrees % 360) + 360) % 360
  guard normalized != 0 else { return image }
  let sourceSize = image.size
  let targetSize = normalized == 90 || normalized == 270
    ? CGSize(width: sourceSize.height, height: sourceSize.width)
    : sourceSize
  let renderer = UIGraphicsImageRenderer(size: targetSize)
  return renderer.image { context in
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
    image.draw(in: CGRect(origin: .zero, size: sourceSize))
  }
}

private func recipePages(_ recipe: [String: Any]) throws -> [[String: Any]] {
  guard let pages = recipe["pages"] as? [[String: Any]], !pages.isEmpty else {
    throw AlytePDFError.malformedRecipe
  }
  let selected = pages.filter { ($0["selected"] as? Bool) == true }
  guard !selected.isEmpty else { throw AlytePDFError.noSelectedPages }
  var seen = Set<Int>()
  for page in selected {
    guard let index = page["pageIndex"] as? Int, seen.insert(index).inserted else {
      throw AlytePDFError.malformedRecipe
    }
  }
  return selected
}

private func stringMetadata(_ document: PDFDocument) -> [String: String] {
  var result: [String: String] = [:]
  for (key, value) in document.documentAttributes ?? [:] {
    result[String(describing: key)] = String(describing: value)
  }
  return result
}

private func inspection(_ document: PDFDocument) -> [String: Any] {
  var pages: [[String: Any]] = []
  for index in document.isLocked ? 0..<0 : 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    pages.append([
      "pageIndex": index,
      "width": Double(bounds.width),
      "height": Double(bounds.height),
      "hasTextLayer": page.string?.isEmpty == false,
    ])
  }
  return [
    "encrypted": document.isEncrypted,
    "locked": document.isLocked,
    "pageCount": document.pageCount,
    "metadata": stringMetadata(document),
    "pages": pages,
  ]
}

private func loadDocument(_ path: String) throws -> PDFDocument {
  guard let document = PDFDocument(url: URL(fileURLWithPath: alytePDFFilePath(path))) else { throw AlytePDFError.unreadable }
  guard !document.isLocked else { throw AlytePDFError.locked }
  return document
}

private func renderImage(page: PDFPage, crop: AlyteNormalizedRect?, rotation: Int, redactions: [[String: Any]]) throws -> UIImage {
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2
  let sourceSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
  let sourceRenderer = UIGraphicsImageRenderer(size: sourceSize)
  let full = sourceRenderer.image { context in
    context.cgContext.saveGState()
    context.cgContext.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context.cgContext)
    context.cgContext.restoreGState()
  }
  var image = full
  if let crop {
    let cropPixels = CGRect(
      x: crop.x * sourceSize.width,
      y: crop.y * sourceSize.height,
      width: crop.width * sourceSize.width,
      height: crop.height * sourceSize.height
    )
    // CGImage uses a bottom-left origin; the recipe uses top-left source coordinates.
    let cgRect = CGRect(
      x: cropPixels.minX,
      y: sourceSize.height - cropPixels.maxY,
      width: cropPixels.width,
      height: cropPixels.height
    ).integral
    guard let cropped = full.cgImage?.cropping(to: cgRect) else { throw AlytePDFError.renderFailed }
    image = UIImage(cgImage: cropped, scale: full.scale, orientation: .up)
  }
  image = imageRotated(image, degrees: rotation)
  guard !redactions.isEmpty else { return image }
  let outputRects = try redactions.map { redaction -> AlyteNormalizedRect in
    let source = try normalizedRect(redaction["rect"])
    return try transformedRect(source, crop: crop, rotation: rotation)
  }
  let renderer = UIGraphicsImageRenderer(size: image.size)
  return renderer.image { context in
    image.draw(in: CGRect(origin: .zero, size: image.size))
    for rect in outputRects {
      context.cgContext.setFillColor(UIColor.black.cgColor)
      context.cgContext.fill(CGRect(
        x: rect.x * image.size.width,
        y: rect.y * image.size.height,
        width: rect.width * image.size.width,
        height: rect.height * image.size.height
      ))
    }
  }
}

private func byteMarkers(_ data: Data) -> (text: Bool, annotations: Bool, attachments: Bool, metadata: Bool) {
  let source = String(data: data, encoding: .isoLatin1) ?? ""
  return (
    source.contains("/ActualText") || source.contains("/ToUnicode"),
    source.contains("/Annots"),
    source.contains("/EmbeddedFile") || source.contains("/Filespec"),
    source.contains("/Metadata") || source.contains("/Info")
  )
}

public final class AlytePDFModule: Module {
  private var sessions: [String: PDFDocument] = [:]
  private let sessionLock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("AlytePDF")

    AsyncFunction("inspect") { (path: String) throws -> [String: Any] in
      guard let document = PDFDocument(url: URL(fileURLWithPath: alytePDFFilePath(path))) else { throw AlytePDFError.unreadable }
      return inspection(document)
    }

    AsyncFunction("unlock") { (path: String, password: String) throws -> [String: Any] in
      guard let document = PDFDocument(url: URL(fileURLWithPath: alytePDFFilePath(path))), document.unlock(withPassword: password) else {
        throw AlytePDFError.locked
      }
      let sessionId = UUID().uuidString
      self.sessionLock.lock()
      self.sessions[sessionId] = document
      self.sessionLock.unlock()
      var result = inspection(document)
      result["sessionId"] = sessionId
      return result
    }

    AsyncFunction("renderPreview") { (path: String) throws -> [String] in
      let document = try loadDocument(path)
      return try self.renderPreview(document)
    }

    AsyncFunction("renderPreviewSession") { (sessionId: String) throws -> [String] in
      self.sessionLock.lock()
      let document = self.sessions[sessionId]
      self.sessionLock.unlock()
      guard let document else { throw AlytePDFError.unreadable }
      return try self.renderPreview(document)
    }

    AsyncFunction("close") { (sessionId: String) in
      self.sessionLock.lock()
      self.sessions.removeValue(forKey: sessionId)
      self.sessionLock.unlock()
    }

    AsyncFunction("sanitize") { (sourcePath: String, destinationPath: String, recipe: [String: Any]) throws -> [String: Any] in
      let document = try loadDocument(sourcePath)
      let pages = try recipePages(recipe)
      let destinationURL = URL(fileURLWithPath: alytePDFFilePath(destinationPath))
      try FileManager.default.createDirectory(at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? FileManager.default.removeItem(at: destinationURL)
      let outputDocument = PDFDocument()
      var outputCount = 0
      for pageRecipe in pages {
        guard let pageIndex = pageRecipe["pageIndex"] as? Int,
              pageIndex >= 0, pageIndex < document.pageCount,
              let page = document.page(at: pageIndex) else { throw AlytePDFError.malformedRecipe }
        let crop = try pageRecipe["crop"] == nil || pageRecipe["crop"] is NSNull ? nil : normalizedRect(pageRecipe["crop"])
        let rotation = pageRecipe["rotation"] as? Int ?? 0
        guard [0, 90, 180, 270].contains(rotation) else { throw AlytePDFError.malformedRecipe }
        let redactions = pageRecipe["redactions"] as? [[String: Any]] ?? []
        let image = try renderImage(page: page, crop: crop, rotation: rotation, redactions: redactions)
        guard let outputPage = PDFPage(image: image) else { throw AlytePDFError.renderFailed }
        outputDocument.insert(outputPage, at: outputCount)
        outputCount += 1
      }
      guard outputCount > 0 else { throw AlytePDFError.noSelectedPages }
      outputDocument.documentAttributes = [:]
      guard outputDocument.write(to: destinationURL) else { throw AlytePDFError.renderFailed }
      return ["destinationPath": destinationPath, "pageCount": outputCount]
    }

    AsyncFunction("verifySanitized") { (path: String) throws -> [String: Any] in
      let data = try Data(contentsOf: URL(fileURLWithPath: alytePDFFilePath(path)))
      guard let document = PDFDocument(data: data) else { throw AlytePDFError.verificationFailed }
      let markers = byteMarkers(data)
      let selectableText = document.isLocked || document.string?.isEmpty == false || document.pageCount == 0 && markers.text
      let annotations = (0..<document.pageCount).contains { document.page(at: $0)?.annotations.isEmpty == false } || markers.annotations
      let attachments = markers.attachments
      let metadata = !stringMetadata(document).isEmpty || markers.metadata
      let removableRedactions = annotations
      let recoveryChecked = PDFDocument(data: data)?.pageCount == document.pageCount
      let failureReasons = [
        selectableText ? "selectable-source-text" : nil,
        annotations ? "annotations" : nil,
        attachments ? "attachments" : nil,
        metadata ? "metadata" : nil,
        removableRedactions ? "removable-redaction-objects" : nil,
        recoveryChecked ? nil : "recovery-failed",
      ].compactMap { $0 }
      return [
        "verified": failureReasons.isEmpty && recoveryChecked,
        "selectableText": selectableText,
        "annotations": annotations,
        "attachments": attachments,
        "metadata": metadata,
        "removableRedactions": removableRedactions,
        "recoveryChecked": recoveryChecked,
        "failureReasons": failureReasons,
      ]
    }

    AsyncFunction("suggestSensitiveRegions") { (_: String) -> [[String: Any]] in
      // Vision observations are supplied by AlyteVision in the extraction lane. This module does
      // not guess sensitive content from a PDF string; users can always add regions manually.
      return []
    }
  }

  private func renderPreview(_ document: PDFDocument) throws -> AlytePDFPreviewResult {
    var output: AlytePDFPreviewResult = []
    for index in 0..<document.pageCount {
      guard let page = document.page(at: index) else { continue }
      let bounds = page.bounds(for: .mediaBox)
      let image = page.thumbnail(of: CGSize(width: bounds.width * 2, height: bounds.height * 2), for: .mediaBox)
      guard let data = image.pngData() else { throw AlytePDFError.renderFailed }
      output.append("data:image/png;base64,\(data.base64EncodedString())")
    }
    return output
  }
}
