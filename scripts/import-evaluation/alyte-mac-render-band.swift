import AppKit
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import PDFKit

private let cropSchemaVersion = "alyte.import-eval.crop.v1"
private let jpegCompression = 0.92

private struct NormalizedRect: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

private struct CropMetadata: Codable {
  let schemaVersion: String
  let reportSha256: String
  let pageIndex: Int
  let normalizedRect: NormalizedRect
  let width: Int
  let height: Int
  let bytes: Int
  let outputPath: String
}

private enum RenderBandError: Error {
  case invalidArguments
  case unsafePrivatePath
  case unreadablePDF
  case lockedPDF
  case invalidPage
  case invalidRect
  case renderFailed
  case encodeFailed
}

private func usage() {
  print("Usage: alyte-mac-render-band --report <pdf> --page <zero-based-index> --rect <x,y,width,height> --output <jpg> [--private-root <dir>]")
  print("       alyte-mac-render-band --self-test")
}

private func argument(_ name: String, in arguments: [String]) -> String? {
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}

private func isWithin(_ child: URL, _ parent: URL) -> Bool {
  let childPath = child.path
  let parentPath = parent.path.hasSuffix("/") ? parent.path : "\(parent.path)/"
  return childPath.hasPrefix(parentPath)
}

private func pathEntryExists(_ url: URL) -> Bool {
  url.withUnsafeFileSystemRepresentation { path in
    guard let path else { return false }
    var information = stat()
    return lstat(path, &information) == 0
  }
}

private func resolvedExistingURL(_ url: URL) -> URL? {
  url.withUnsafeFileSystemRepresentation { path in
    guard let path, let resolved = realpath(path, nil) else { return nil }
    defer { free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved)).standardizedFileURL
  }
}

private func resolvedURL(_ url: URL) -> URL {
  url.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
}

private func isRegularFile(_ url: URL) -> Bool {
  var isDirectory: ObjCBool = false
  return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && !isDirectory.boolValue
}

private func nearestExistingAncestor(_ url: URL) -> URL {
  var current = url.standardizedFileURL
  while !pathEntryExists(current) {
    let parent = current.deletingLastPathComponent()
    if parent.path == current.path { return current }
    current = parent
  }
  return current
}

private func parseRect(_ value: String) throws -> NormalizedRect {
  let parts = value.split(separator: ",", omittingEmptySubsequences: false)
  guard parts.count == 4,
    let x = Double(parts[0]),
    let y = Double(parts[1]),
    let width = Double(parts[2]),
    let height = Double(parts[3]),
    x.isFinite, y.isFinite, width.isFinite, height.isFinite,
    x >= 0, y >= 0, width > 0, height > 0,
    x + width <= 1, y + height <= 1
  else { throw RenderBandError.invalidRect }
  return NormalizedRect(x: x, y: y, width: width, height: height)
}

private func privateRootURL(reportURL: URL, explicitRoot: String?) throws -> URL {
  if let explicitRoot {
    return URL(fileURLWithPath: explicitRoot, isDirectory: true).standardizedFileURL
  }
  let reports = reportURL.deletingLastPathComponent()
  guard reports.lastPathComponent == "reports" else { throw RenderBandError.unsafePrivatePath }
  return reports.deletingLastPathComponent().standardizedFileURL
}

private func validatePrivatePaths(reportURL: URL, outputURL: URL, rootURL: URL) throws {
  let root = resolvedURL(rootURL)
  let reportLexical = reportURL.standardizedFileURL
  let outputLexical = outputURL.standardizedFileURL
  // Promoted and staged copies are both valid inputs. The source must be a regular file whose
  // resolved path remains below the private evaluation root.
  guard isWithin(outputLexical, root) else { throw RenderBandError.unsafePrivatePath }
  guard outputLexical.pathExtension.lowercased() == "jpg" else {
    throw RenderBandError.unsafePrivatePath
  }
  guard isRegularFile(reportLexical) else {
    throw RenderBandError.unreadablePDF
  }
  guard let resolvedReport = resolvedExistingURL(reportLexical), isWithin(resolvedReport, root) else {
    throw RenderBandError.unsafePrivatePath
  }
  let parent = outputLexical.deletingLastPathComponent()
  // Resolve the existing ancestor chain before creating anything. This rejects a symlinked
  // output directory before FileManager could follow it outside the private evaluation root.
  guard let resolvedParent = resolvedExistingURL(nearestExistingAncestor(parent)), isWithin(resolvedParent, root) else {
    throw RenderBandError.unsafePrivatePath
  }
  try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
  guard let createdParent = resolvedExistingURL(parent), isWithin(createdParent, root) else {
    throw RenderBandError.unsafePrivatePath
  }
  if pathEntryExists(outputLexical) {
    guard let resolvedOutput = resolvedExistingURL(outputLexical), isWithin(resolvedOutput, root) else {
      throw RenderBandError.unsafePrivatePath
    }
  }
}

private func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func renderImage(page: PDFPage, crop: NormalizedRect) throws -> CGImage {
  let bounds = page.bounds(for: .mediaBox)
  let scale: CGFloat = 2
  let sourceWidth = max(1, Int((bounds.width * scale).rounded()))
  let sourceHeight = max(1, Int((bounds.height * scale).rounded()))
  guard let context = CGContext(
    data: nil,
    width: sourceWidth,
    height: sourceHeight,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { throw RenderBandError.renderFailed }
  let sourceSize = CGSize(width: sourceWidth, height: sourceHeight)

  // UIGraphicsImageRenderer starts with UIKit's top-left, y-down user space. A raw macOS bitmap
  // context starts in Quartz's bottom-left, y-up user space, so establish the equivalent initial
  // CTM before applying the production transform below. Without this first flip, the production
  // bridge is applied against the wrong initial coordinate system and the crop is vertically
  // mirrored.
  context.translateBy(x: 0, y: sourceSize.height)
  context.scaleBy(x: 1, y: -1)

  // This is intentionally the same media-box scale, opaque white fill, and bottom-left to
  // top-left bridge used by AlytePDFModule.renderImage on iOS.
  context.setFillColor(NSColor.white.cgColor)
  context.fill(CGRect(origin: .zero, size: sourceSize))
  context.saveGState()
  context.translateBy(x: 0, y: sourceSize.height)
  context.scaleBy(x: scale, y: -scale)
  page.draw(with: .mediaBox, to: context)
  context.restoreGState()
  guard let full = context.makeImage() else { throw RenderBandError.renderFailed }

  let pixelWidth = CGFloat(full.width)
  let pixelHeight = CGFloat(full.height)
  let cropPixels = CGRect(
    x: CGFloat(crop.x) * pixelWidth,
    y: CGFloat(crop.y) * pixelHeight,
    width: CGFloat(crop.width) * pixelWidth,
    height: CGFloat(crop.height) * pixelHeight
  )
  // Match the production crop's y inversion and integral rounding exactly.
  let cgRect = CGRect(
    x: cropPixels.minX,
    y: pixelHeight - cropPixels.maxY,
    width: cropPixels.width,
    height: cropPixels.height
  ).integral
  guard cgRect.width > 0, cgRect.height > 0, let cropped = full.cropping(to: cgRect) else {
    throw RenderBandError.renderFailed
  }
  return cropped
}

private func encodeJPEG(_ image: CGImage, to destination: URL) throws -> Int {
  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let data = bitmap.representation(
    using: .jpeg,
    properties: [.compressionFactor: jpegCompression]
  ), !data.isEmpty else { throw RenderBandError.encodeFailed }
  try data.write(to: destination, options: [.atomic])
  return data.count
}

private func render(reportURL: URL, pageIndex: Int, crop: NormalizedRect, outputURL: URL) throws -> CropMetadata {
  guard let document = PDFDocument(url: reportURL) else { throw RenderBandError.unreadablePDF }
  guard !document.isLocked else { throw RenderBandError.lockedPDF }
  guard pageIndex >= 0, pageIndex < document.pageCount, let page = document.page(at: pageIndex) else {
    throw RenderBandError.invalidPage
  }
  let image = try renderImage(page: page, crop: crop)
  let bytes = try encodeJPEG(image, to: outputURL)
  let reportData = try Data(contentsOf: reportURL)
  return CropMetadata(
    schemaVersion: cropSchemaVersion,
    reportSha256: sha256(reportData),
    pageIndex: pageIndex,
    normalizedRect: crop,
    width: image.width,
    height: image.height,
    bytes: bytes,
    outputPath: outputURL.path
  )
}

private func selfTest() throws {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("alyte-mac-render-band-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }
  let sourceURL = directory.appendingPathComponent("synthetic.pdf")
  let outputURL = directory.appendingPathComponent("synthetic.jpg")
  let document = PDFDocument()
  let image = NSImage(size: NSSize(width: 100, height: 80))
  image.lockFocus()
  // Asymmetric landmarks make a vertical mirror observable: blue is at the source top and red
  // is at the source bottom. The corrected renderer must preserve that order in the output.
  NSColor.systemRed.setFill()
  NSRect(x: 0, y: 0, width: 100, height: 40).fill()
  NSColor.systemBlue.setFill()
  NSRect(x: 0, y: 40, width: 100, height: 40).fill()
  image.unlockFocus()
  guard let page = PDFPage(image: image) else { throw RenderBandError.renderFailed }
  document.insert(page, at: 0)
  guard document.write(to: sourceURL) else { throw RenderBandError.renderFailed }
  let privateRoot = directory.appendingPathComponent("private", isDirectory: true)
  let stagedDirectory = privateRoot.appendingPathComponent("staged", isDirectory: true)
  let renderedDirectory = privateRoot.appendingPathComponent("rendered", isDirectory: true)
  try FileManager.default.createDirectory(at: stagedDirectory, withIntermediateDirectories: true)
  try FileManager.default.createDirectory(at: renderedDirectory, withIntermediateDirectories: true)
  let stagedURL = stagedDirectory.appendingPathComponent("promoted-copy.pdf")
  let stagedOutputURL = renderedDirectory.appendingPathComponent("promoted-copy.jpg")
  try FileManager.default.copyItem(at: sourceURL, to: stagedURL)
  try validatePrivatePaths(reportURL: stagedURL, outputURL: stagedOutputURL, rootURL: privateRoot)
  let stagedMetadata = try render(
    reportURL: resolvedURL(stagedURL),
    pageIndex: 0,
    crop: NormalizedRect(x: 0, y: 0, width: 1, height: 1),
    outputURL: stagedOutputURL
  )
  guard stagedMetadata.bytes > 0 else { throw RenderBandError.renderFailed }

  func expectUnsafe(_ operation: () throws -> Void) throws {
    do {
      try operation()
      throw RenderBandError.renderFailed
    } catch RenderBandError.unsafePrivatePath {
      return
    }
  }
  let outsideOutputURL = directory.appendingPathComponent("outside.jpg")
  try expectUnsafe {
    try validatePrivatePaths(
      reportURL: stagedURL,
      outputURL: outsideOutputURL,
      rootURL: privateRoot
    )
  }
  let outsideDirectory = directory.appendingPathComponent("outside", isDirectory: true)
  try FileManager.default.createDirectory(at: outsideDirectory, withIntermediateDirectories: true)
  let symlinkDirectory = privateRoot.appendingPathComponent("symlink", isDirectory: true)
  try FileManager.default.createSymbolicLink(at: symlinkDirectory, withDestinationURL: outsideDirectory)
  let symlinkOutputURL = symlinkDirectory.appendingPathComponent("escaped.jpg")
  try expectUnsafe {
    try validatePrivatePaths(
      reportURL: stagedURL,
      outputURL: symlinkOutputURL,
      rootURL: privateRoot
    )
  }
  let danglingDirectory = privateRoot.appendingPathComponent("dangling", isDirectory: true)
  let missingDestination = directory.appendingPathComponent("missing-target", isDirectory: true)
  try FileManager.default.createSymbolicLink(at: danglingDirectory, withDestinationURL: missingDestination)
  let danglingOutputURL = danglingDirectory.appendingPathComponent("escaped.jpg")
  try expectUnsafe {
    try validatePrivatePaths(
      reportURL: stagedURL,
      outputURL: danglingOutputURL,
      rootURL: privateRoot
    )
  }
  let rendered = try renderImage(
    page: page,
    crop: NormalizedRect(x: 0, y: 0, width: 1, height: 1)
  )
  guard let bytes = rendered.dataProvider?.data as Data? else { throw RenderBandError.renderFailed }
  func blueDominates(atTopRow row: Int) -> Bool {
    let x = rendered.width / 2
    let offset = row * rendered.bytesPerRow + x * 4
    guard offset + 2 < bytes.count else { return false }
    return bytes[offset + 2] > bytes[offset] && bytes[offset + 2] > bytes[offset + 1]
  }
  guard blueDominates(atTopRow: 10), !blueDominates(atTopRow: rendered.height - 11) else {
    throw RenderBandError.renderFailed
  }
  let metadata = try render(
    reportURL: sourceURL,
    pageIndex: 0,
    crop: NormalizedRect(x: 0.25, y: 0.125, width: 0.5, height: 0.5),
    outputURL: outputURL
  )
  // 100x80 points at scale 2, cropped to 50% width/height.
  guard metadata.width == 100, metadata.height == 80, metadata.bytes > 0 else {
    throw RenderBandError.renderFailed
  }
  print("synthetic crop geometry and private-path checks passed")
}

private func main() throws {
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
    let pageText = argument("--page", in: arguments),
    let pageIndex = Int(pageText),
    let rectText = argument("--rect", in: arguments),
    let output = argument("--output", in: arguments),
    pageIndex >= 0
  else { throw RenderBandError.invalidArguments }
  let reportURL = URL(fileURLWithPath: report).standardizedFileURL
  let outputURL = URL(fileURLWithPath: output).standardizedFileURL
  let rootURL = try privateRootURL(
    reportURL: reportURL,
    explicitRoot: argument("--private-root", in: arguments)
  )
  try validatePrivatePaths(reportURL: reportURL, outputURL: outputURL, rootURL: rootURL)
  let metadata = try render(
    reportURL: resolvedURL(reportURL),
    pageIndex: pageIndex,
    crop: try parseRect(rectText),
    outputURL: outputURL
  )
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  let data = try encoder.encode(metadata)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

do {
  try main()
} catch {
  fputs("alyte-mac-render-band failed\n", stderr)
  exit(1)
}

