import CryptoKit
import Foundation
import PDFKit

private let glyphReaderVersion = "alyte.mac.pdfkit-glyph-reader.v2"
private let maximumRuntimeVersionLength = 64

private enum GlyphReaderError: Error {
  case invalidArguments
  case unsafePrivatePath
  case unreadablePDF
  case lockedPDF
  case invalidRuntimeVersion
  case writeFailed
  case selfTestFailed
}

private struct GlyphCounts {
  var total = 0
  var visible = 0
  var boundedVisible = 0
  var unboundedVisible = 0
}

private enum GlyphGeometryMethod: String {
  case selectionBounds = "selectionBounds"
  case characterBounds = "characterBounds"
  case selectionInvalid = "selectionInvalid"
}

private func argument(_ name: String, in arguments: [String]) -> String? {
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

private func isWithin(_ child: URL, _ parent: URL) -> Bool {
  let childPath = child.path
  let parentPath = parent.path.hasSuffix("/") ? parent.path : "\(parent.path)/"
  return childPath == parent.path || childPath.hasPrefix(parentPath)
}

private func resolvedURL(_ url: URL) -> URL {
  url.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
}

private func absoluteURL(path: String, isDirectory: Bool = false) -> URL {
  URL(fileURLWithPath: path, isDirectory: isDirectory).standardizedFileURL.absoluteURL
}

private func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func validateRuntimeVersion(_ value: String) throws -> String {
  guard !value.isEmpty, value.utf8.count <= maximumRuntimeVersionLength,
    value.unicodeScalars.allSatisfy({
      CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "_" || $0 == "-"
    })
  else { throw GlyphReaderError.invalidRuntimeVersion }
  return value
}

private func validatePrivatePaths(reportURL: URL, outputURL: URL, rootURL: URL) throws -> (URL, URL) {
  let root = resolvedURL(rootURL)
  guard root.path != "/" else { throw GlyphReaderError.unsafePrivatePath }
  var rootIsDirectory = ObjCBool(false)
  guard FileManager.default.fileExists(atPath: root.path, isDirectory: &rootIsDirectory),
    rootIsDirectory.boolValue
  else { throw GlyphReaderError.unsafePrivatePath }

  let reportLexical = reportURL.standardizedFileURL
  let outputLexical = outputURL.standardizedFileURL
  guard isWithin(reportLexical, root), isWithin(outputLexical, root),
    outputLexical.pathExtension.lowercased() == "json"
  else { throw GlyphReaderError.unsafePrivatePath }

  var reportIsDirectory = ObjCBool(false)
  guard FileManager.default.fileExists(atPath: reportLexical.path, isDirectory: &reportIsDirectory),
    !reportIsDirectory.boolValue
  else { throw GlyphReaderError.unreadablePDF }
  guard isWithin(resolvedURL(reportLexical), root) else {
    throw GlyphReaderError.unsafePrivatePath
  }

  // Resolve every existing ancestor before creating the output directory. This keeps a
  // symlinked output component from escaping the private evaluation root.
  let parent = outputLexical.deletingLastPathComponent()
  guard isWithin(resolvedURL(parent), root) else { throw GlyphReaderError.unsafePrivatePath }
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
  try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)
  guard isWithin(resolvedURL(parent), root) else { throw GlyphReaderError.unsafePrivatePath }
  if FileManager.default.fileExists(atPath: outputLexical.path) {
    guard isWithin(resolvedURL(outputLexical), root) else {
      throw GlyphReaderError.unsafePrivatePath
    }
  }
  return (resolvedURL(reportLexical), outputLexical)
}

private func normalizedBox(_ bounds: CGRect?) -> Any {
  guard let bounds else { return NSNull() }
  return [
    "x": Double(bounds.origin.x),
    "y": Double(bounds.origin.y),
    "width": Double(bounds.size.width),
    "height": Double(bounds.size.height),
  ]
}

private func glyphDictionary(_ glyph: AlytePDFTextGlyph) -> [String: Any] {
  [
    "start": glyph.range.location,
    "end": NSMaxRange(glyph.range),
    "text": glyph.text,
    "boundingBox": normalizedBox(glyph.bounds),
    "visible": glyph.visible,
  ]
}

private func glyphGeometryMethod(
  page: PDFPage, source: NSString
) -> GlyphGeometryMethod {
  guard let selection = page.selection(for: NSRange(location: 0, length: source.length)) else {
    return .characterBounds
  }
  var lineRanges: [NSRange] = []
  for line in selection.selectionsByLine() {
    guard line.numberOfTextRanges(on: page) == 1 else { return .selectionInvalid }
    lineRanges.append(line.range(at: 0, on: page))
  }
  guard alytePDFValidatedTextLineRanges(source: source, lineRanges: lineRanges) != nil else {
    return .selectionInvalid
  }
  return .selectionBounds
}

private func read(
  reportURL: URL,
  outputURL: URL,
  rootURL: URL,
  runtimeVersion: String
) throws -> GlyphCounts {
  let (safeReportURL, safeOutputURL) = try validatePrivatePaths(
    reportURL: reportURL, outputURL: outputURL, rootURL: rootURL)
  let reportData: Data
  do {
    reportData = try Data(contentsOf: safeReportURL, options: [.mappedIfSafe])
  } catch {
    throw GlyphReaderError.unreadablePDF
  }
  guard let document = PDFDocument(data: reportData) else { throw GlyphReaderError.unreadablePDF }
  guard !document.isLocked else { throw GlyphReaderError.lockedPDF }

  var pages: [[String: Any]] = []
  pages.reserveCapacity(document.pageCount)
  var counts = GlyphCounts()
  var baselinePageCount = 0
  var glyphPageCount = 0
  for pageIndex in 0..<document.pageCount {
    guard let page = document.page(at: pageIndex) else { throw GlyphReaderError.unreadablePDF }
    let pageBounds = page.bounds(for: .mediaBox)
    let rotation = ((page.rotation % 360) + 360) % 360
    let baseline = alytePDFTextLayerPage(document: document, pageIndex: pageIndex)
    if baseline != nil { baselinePageCount += 1 }
    let source = (page.string ?? "") as NSString
    let geometryMethod = glyphGeometryMethod(page: page, source: source)
    let glyphs: [AlytePDFTextGlyph]
    switch geometryMethod {
    case .selectionBounds:
      glyphs = alytePDFTextGlyphs(
        page: page,
        source: source,
        pageBounds: pageBounds,
        rotation: rotation,
        selectionBounds: { range in page.selection(for: range)?.bounds(for: page) }
      ) ?? []
    case .characterBounds:
      glyphs = alytePDFTextGlyphs(
        page: page, source: source, pageBounds: pageBounds, rotation: rotation
      ) ?? []
    case .selectionInvalid:
      // Match the baseline's fail-closed selection path. Character bounds are not substituted
      // when PDFSelection exists but cannot prove complete line ranges.
      glyphs = []
    }
    if !glyphs.isEmpty { glyphPageCount += 1 }
    counts.total += glyphs.count
    counts.visible += glyphs.filter(\.visible).count
    counts.boundedVisible += glyphs.filter { $0.visible && $0.bounds != nil }.count
    counts.unboundedVisible += glyphs.filter { $0.visible && $0.bounds == nil }.count
    pages.append([
      "width": Double(pageBounds.width),
      "height": Double(pageBounds.height),
      "pageIndex": pageIndex,
      "glyphGeometryMethod": geometryMethod.rawValue,
      // Keep the deterministic baseline result as returned by the existing adapter. Glyph
      // evidence is a sibling field, so no observation or source range is rewritten.
      "result": baseline ?? NSNull(),
      "glyphs": glyphs.map(glyphDictionary),
    ])
  }

  let envelope: [String: Any] = [
    "readerVersion": glyphReaderVersion,
    "baselineReaderVersion": alytePDFTextLayerAdapterVersion,
    "runtimeVersion": runtimeVersion,
    "reportSha256": sha256(reportData),
    "pageCount": document.pageCount,
    "pages": pages,
  ]
  guard JSONSerialization.isValidJSONObject(envelope) else { throw GlyphReaderError.writeFailed }
  do {
    let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
    try data.write(to: safeOutputURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: safeOutputURL.path)
  } catch {
    throw GlyphReaderError.writeFailed
  }

  let summary: [String: Any] = [
    "pages": document.pageCount,
    "baselinePages": baselinePageCount,
    "glyphPages": glyphPageCount,
    "glyphs": counts.total,
    "visibleGlyphs": counts.visible,
    "boundedVisibleGlyphs": counts.boundedVisible,
    "unboundedVisibleGlyphs": counts.unboundedVisible,
  ]
  let summaryData = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
  FileHandle.standardOutput.write(summaryData)
  FileHandle.standardOutput.write(Data([0x0a]))
  return counts
}

private final class SyntheticTextPage: PDFPage {
  private let syntheticText: String
  private let syntheticMediaBox: CGRect
  private let syntheticCharacterBounds: [CGRect]

  init(text: String, mediaBox: CGRect, characterBounds: [CGRect]) {
    syntheticText = text
    syntheticMediaBox = mediaBox
    syntheticCharacterBounds = characterBounds
    super.init()
    setBounds(mediaBox, for: .mediaBox)
  }

  override var string: String? { syntheticText }

  override var numberOfCharacters: Int { (syntheticText as NSString).length }

  override func bounds(for box: PDFDisplayBox) -> CGRect { syntheticMediaBox }

  override func characterBounds(at index: Int) -> CGRect {
    guard index >= 0, index < syntheticCharacterBounds.count else { return .zero }
    return syntheticCharacterBounds[index]
  }
}

private func selfTest() throws {
  // A composed character exercises UTF-16 ranges; whitespace exercises the intentional nil-box
  // rule. The asymmetric boxes make it observable that the normalized page geometry is retained.
  let text = "A\u{301} 12"
  let source = text as NSString
  let pageBounds = CGRect(x: 0, y: 0, width: 100, height: 100)
  let boxes = [
    CGRect(x: 10, y: 70, width: 8, height: 12),
    CGRect(x: 10, y: 70, width: 8, height: 12),
    CGRect.zero,
    CGRect(x: 32, y: 70, width: 8, height: 12),
    CGRect(x: 44, y: 70, width: 8, height: 12),
  ]
  let page = SyntheticTextPage(text: text, mediaBox: pageBounds, characterBounds: boxes)
  guard let glyphs = alytePDFTextGlyphs(
    page: page, source: source, pageBounds: pageBounds, rotation: 0
  ), glyphs.count == 4,
    glyphs.map(\.range) == [
      NSRange(location: 0, length: 2), NSRange(location: 2, length: 1),
      NSRange(location: 3, length: 1), NSRange(location: 4, length: 1),
    ], glyphs.map(\.text) == ["A\u{301}", " ", "1", "2"],
    glyphs.map(\.visible) == [true, false, true, true],
    glyphs[0].bounds != nil, glyphs[1].bounds == nil,
    glyphs[2].bounds != nil, glyphs[3].bounds != nil
  else { throw GlyphReaderError.selfTestFailed }

  let summary: [String: Any] = [
    "selfTest": true,
    "glyphs": glyphs.count,
    "visibleGlyphs": glyphs.filter(\.visible).count,
    "boundedVisibleGlyphs": glyphs.filter { $0.visible && $0.bounds != nil }.count,
  ]
  let data = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func usage() {
  fputs("Usage: alyte-mac-pdfkit-glyph-reader --report <pdf> --output <json> --private-root <dir> --runtime-version <version>\n", stdout)
  fputs("       alyte-mac-pdfkit-glyph-reader --self-test\n", stdout)
}

private func run() throws {
  let arguments = Array(CommandLine.arguments.dropFirst())
  if arguments.contains("--help") {
    usage()
    return
  }
  if arguments.contains("--self-test") {
    try selfTest()
    return
  }
  guard let report = argument("--report", in: arguments),
    let output = argument("--output", in: arguments),
    let privateRoot = argument("--private-root", in: arguments),
    let runtime = argument("--runtime-version", in: arguments)
  else { throw GlyphReaderError.invalidArguments }
  let runtimeVersion = try validateRuntimeVersion(runtime)
  _ = try read(
    reportURL: absoluteURL(path: report),
    outputURL: absoluteURL(path: output),
    rootURL: absoluteURL(path: privateRoot, isDirectory: true),
    runtimeVersion: runtimeVersion
  )
}

@main
private struct GlyphReaderMain {
  static func main() {
    do {
      try run()
    } catch {
      fputs("alyte-mac-pdfkit-glyph-reader failed\n", stderr)
      exit(1)
    }
  }
}
