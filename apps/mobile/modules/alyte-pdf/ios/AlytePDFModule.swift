import ExpoModulesCore
import Foundation
import PDFKit
import UIKit
import Vision

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
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
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
  let sourceFormat = UIGraphicsImageRendererFormat()
  sourceFormat.scale = 1
  sourceFormat.opaque = true
  let sourceRenderer = UIGraphicsImageRenderer(size: sourceSize, format: sourceFormat)
  let full = sourceRenderer.image { context in
    context.cgContext.saveGState()
    context.cgContext.scaleBy(x: scale, y: scale)
    page.draw(with: .mediaBox, to: context.cgContext)
    context.cgContext.restoreGState()
  }
  var image = full
  if let crop {
    let pixelWidth = CGFloat(full.cgImage?.width ?? Int(sourceSize.width))
    let pixelHeight = CGFloat(full.cgImage?.height ?? Int(sourceSize.height))
    let cropPixels = CGRect(
      x: crop.x * pixelWidth,
      y: crop.y * pixelHeight,
      width: crop.width * pixelWidth,
      height: crop.height * pixelHeight
    )
    // CGImage uses a bottom-left origin; the recipe uses top-left source coordinates.
    let cgRect = CGRect(
      x: cropPixels.minX,
      y: pixelHeight - cropPixels.maxY,
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
  let overlayFormat = UIGraphicsImageRendererFormat()
  overlayFormat.scale = 1
  overlayFormat.opaque = true
  let renderer = UIGraphicsImageRenderer(size: image.size, format: overlayFormat)
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
    // PDFKit may add a generated /Info dictionary. XMP /Metadata is not emitted by the
    // image-only writer and is therefore still a meaningful failure marker.
    source.contains("/Metadata")
  )
}

private struct AlyteSourceEvidence {
  let text: [String]
  let metadata: [String]
  let annotationCount: Int
}

private func sourceEvidence(_ document: PDFDocument) -> AlyteSourceEvidence {
  let text = (0..<document.pageCount).compactMap { index in
    document.page(at: index)?.string
  }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  let metadata = (document.documentAttributes ?? [:]).compactMap { entry in
    let key = String(describing: entry.key)
    guard !["CreationDate", "ModDate", "Producer", "Creator", "Trapped"].contains(key) else { return nil }
    let value = entry.value
    let string = String(describing: value)
    return string.isEmpty ? nil : string
  }
  let annotationCount = (0..<document.pageCount).reduce(0) { count, index in
    count + (document.page(at: index)?.annotations.count ?? 0)
  }
  return AlyteSourceEvidence(text: text, metadata: metadata, annotationCount: annotationCount)
}

private func permittedGeneratedMetadataKey(_ key: String) -> Bool {
  ["CreationDate", "ModDate", "Producer", "Creator", "Title", "Subject", "Author", "Keywords", "Trapped"].contains(key)
}

private func verifySanitizedData(
  _ data: Data,
  forbiddenStrings: [String] = [],
  evidence: AlyteSourceEvidence? = nil
) throws -> [String: Any] {
  guard let document = PDFDocument(data: data), document.pageCount > 0 else { throw AlytePDFError.verificationFailed }
  let markers = byteMarkers(data)
  let seededContent = forbiddenStrings.contains { needle in
    let bytes = data.range(of: Data(needle.utf8)) != nil
    return bytes || (document.string?.localizedCaseInsensitiveContains(needle) == true)
  }
  let selectableText = seededContent || document.string?.isEmpty == false || markers.text
  let annotations = (0..<document.pageCount).contains { document.page(at: $0)?.annotations.isEmpty == false } || markers.annotations
  let attachments = markers.attachments
  let metadata = stringMetadata(document).contains { key, _ in !permittedGeneratedMetadataKey(key) } || markers.metadata
  let removableRedactions = annotations
  let reloadChecked = PDFDocument(data: data)?.pageCount == document.pageCount
  let sourceStrings = (evidence?.text ?? []) + (evidence?.metadata ?? []) + forbiddenStrings
  let sourceValueSurvived = sourceStrings.contains { needle in
    let utf16Bytes = needle.utf16.flatMap { [UInt8($0 & 0xff), UInt8($0 >> 8)] }
    data.range(of: Data(needle.utf8)) != nil ||
      data.range(of: Data(utf16Bytes)) != nil ||
      document.string?.localizedCaseInsensitiveContains(needle) == true
  }
  let sourceObjectsRemoved = (evidence?.annotationCount ?? 0) == 0 || !annotations
  let sourceContentRemoved = evidence != nil && !sourceValueSurvived && sourceObjectsRemoved && !attachments && !metadata
  let sourceAwareChecked = evidence != nil && sourceContentRemoved
  let failureReasons = [
    selectableText ? "selectable-source-text" : nil,
    annotations ? "annotations" : nil,
    attachments ? "attachments" : nil,
    metadata ? "metadata" : nil,
    removableRedactions ? "removable-redaction-objects" : nil,
    reloadChecked ? nil : "reload-failed",
    evidence != nil && !sourceContentRemoved ? "source-content-recovery-detected" : nil,
  ].compactMap { $0 }
  return [
    "verified": failureReasons.isEmpty && reloadChecked,
    "selectableText": selectableText,
    "annotations": annotations,
    "attachments": attachments,
    "metadata": metadata,
    "removableRedactions": removableRedactions,
    "reloadChecked": reloadChecked,
    "sourceAwareChecked": sourceAwareChecked,
    "sourceContentRemoved": sourceContentRemoved,
    "verificationVersion": "source-aware-v1",
    "failureReasons": failureReasons,
  ]
}

private func sensitiveVisionRegions(_ document: PDFDocument) throws -> [[String: Any]] {
  let terms = ["name", "address", "dob", "date of birth", "phone", "email", "patient", "member", "identifier", "medical record", "mrn"]
  var result: [[String: Any]] = []
  for pageIndex in 0..<document.pageCount {
    guard let page = document.page(at: pageIndex) else { continue }
    let bounds = page.bounds(for: .mediaBox)
    let thumbnail = page.thumbnail(of: CGSize(width: max(320, bounds.width * 2), height: max(320, bounds.height * 2)), for: .mediaBox)
    guard let cgImage = thumbnail.cgImage else { continue }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up)
    try handler.perform([request])
    for (index, observation) in (request.results ?? []).enumerated() {
      guard let candidate = observation.topCandidates(1).first,
            terms.contains(where: { candidate.string.lowercased().contains($0) }) else { continue }
      let box = observation.boundingBox
      let x = max(0, min(1, box.minX))
      let y = max(0, min(1, 1 - box.maxY))
      let width = max(0.01, min(1 - x, box.width))
      let height = max(0.01, min(1 - y, box.height))
      result.append([
        "id": "vision-sensitive-\(pageIndex)-\(index)",
        "pageIndex": pageIndex,
        "rect": ["x": Double(x), "y": Double(y), "width": Double(width), "height": Double(height)],
        "label": "possible personal identifier",
      ])
    }
  }
  return result
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
      return try self.sanitize(document: document, destinationPath: destinationPath, recipe: recipe)
    }

    AsyncFunction("verifySanitized") { (path: String) throws -> [String: Any] in
      let data = try Data(contentsOf: URL(fileURLWithPath: alytePDFFilePath(path)))
      return try verifySanitizedData(data)
    }

    AsyncFunction("sanitizeSession") { (sessionId: String, destinationPath: String, recipe: [String: Any]) throws -> [String: Any] in
      self.sessionLock.lock()
      let document = self.sessions[sessionId]
      self.sessionLock.unlock()
      guard let document else { throw AlytePDFError.unreadable }
      return try self.sanitize(document: document, destinationPath: destinationPath, recipe: recipe)
    }

    AsyncFunction("suggestSensitiveRegionsSession") { (sessionId: String) throws -> [[String: Any]] in
      self.sessionLock.lock()
      let document = self.sessions[sessionId]
      self.sessionLock.unlock()
      guard let document else { throw AlytePDFError.unreadable }
      return try sensitiveVisionRegions(document)
    }

    AsyncFunction("suggestSensitiveRegions") { (path: String) throws -> [[String: Any]] in
      return try sensitiveVisionRegions(loadDocument(path))
    }
  }

  fileprivate func sanitize(document: PDFDocument, destinationPath: String, recipe: [String: Any]) throws -> [String: Any] {
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
    // Never copy source document attributes, page objects, or source PDF data into the derivative.
    outputDocument.documentAttributes = [:]
    guard outputDocument.write(to: destinationURL) else { throw AlytePDFError.renderFailed }
    let evidence = sourceEvidence(document)
    let verification = try verifySanitizedData(Data(contentsOf: destinationURL), evidence: evidence)
    return ["destinationPath": destinationPath, "pageCount": outputCount, "verification": verification]
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

/// Test/host seam: XCTest invokes the same image-only writer and verifier used by the Expo
/// functions. It accepts synthetic forbidden source strings to make hidden-text recovery checks
/// adversarial rather than a nominal page-count parse.
public enum AlytePDFSanitizationTestSupport {
  public static func render(document: PDFDocument, destinationURL: URL, recipe: [String: Any]) throws -> [String: Any] {
    let module = AlytePDFModule()
    return try module.sanitize(document: document, destinationPath: destinationURL.path, recipe: recipe)
  }

  public static func verify(url: URL, forbiddenStrings: [String] = []) throws -> [String: Any] {
    return try verifySanitizedData(Data(contentsOf: url), forbiddenStrings: forbiddenStrings)
  }
}
