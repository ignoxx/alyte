#if canImport(ExpoModulesCore)
import ExpoModulesCore
#endif
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

private struct AlyteImageRect {
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat

  var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
  var minX: CGFloat { x }
  var minY: CGFloat { y }
  var maxX: CGFloat { x + width }
  var maxY: CGFloat { y + height }
}

private enum AlyteImageError: LocalizedError {
  case unreadable
  case malformedRecipe
  case renderFailed
  case verificationFailed([String])

  var errorDescription: String? {
    switch self {
    case .unreadable: return "The image could not be opened"
    case .malformedRecipe: return "The image sanitization recipe is invalid"
    case .renderFailed: return "The sanitized image could not be rendered"
    case .verificationFailed(let reasons):
      return "The sanitized image failed verification: \(reasons.joined(separator: ","))"
    }
  }
}

private func alyteImageFilePath(_ value: String) -> String {
  if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
  return value
}

private func bridgeDictionary(_ value: Any?) -> [String: Any]? {
  if let dictionary = value as? [String: Any] { return dictionary }
  guard let dictionary = value as? NSDictionary else { return nil }
  var result: [String: Any] = [:]
  for (key, value) in dictionary {
    guard let stringKey = key as? String else { return nil }
    result[stringKey] = value
  }
  return result
}

private func bridgeArray(_ value: Any?) -> [Any]? {
  if let array = value as? [Any] { return array }
  return (value as? NSArray)?.map { $0 }
}

private func bridgeNumber(_ value: Any?) -> NSNumber? {
  guard let number = value as? NSNumber else { return nil }
  guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
  return number
}

private func bridgeBoolean(_ value: Any?) -> Bool? {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
    return nil
  }
  return number.boolValue
}

private func bridgeDouble(_ value: Any?) -> Double? {
  guard let number = bridgeNumber(value) else { return nil }
  let value = number.doubleValue
  return value.isFinite ? value : nil
}

private func bridgeInteger(_ value: Any?) -> Int? {
  guard let number = bridgeNumber(value) else { return nil }
  let value = number.doubleValue
  guard value.isFinite, value.rounded(.towardZero) == value,
    value >= Double(Int.min), value <= Double(Int.max)
  else { return nil }
  return Int(value)
}

private func normalizedRect(_ value: Any?) throws -> AlyteImageRect {
  guard let dictionary = bridgeDictionary(value),
    let x = bridgeDouble(dictionary["x"]),
    let y = bridgeDouble(dictionary["y"]),
    let width = bridgeDouble(dictionary["width"]),
    let height = bridgeDouble(dictionary["height"]),
    x >= 0, y >= 0, width > 0, height > 0, x + width <= 1, y + height <= 1
  else { throw AlyteImageError.malformedRecipe }
  return AlyteImageRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
}

private func transformedRect(_ rect: AlyteImageRect, crop: AlyteImageRect?, rotation: Int)
  throws -> AlyteImageRect
{
  let area = crop ?? AlyteImageRect(x: 0, y: 0, width: 1, height: 1)
  guard rect.x >= area.x, rect.y >= area.y,
    rect.x + rect.width <= area.x + area.width,
    rect.y + rect.height <= area.y + area.height
  else { throw AlyteImageError.malformedRecipe }
  let local = AlyteImageRect(
    x: (rect.x - area.x) / area.width,
    y: (rect.y - area.y) / area.height,
    width: rect.width / area.width,
    height: rect.height / area.height
  )
  switch ((rotation % 360) + 360) % 360 {
  case 0: return local
  case 90:
    return AlyteImageRect(
      x: 1 - local.y - local.height, y: local.x, width: local.height, height: local.width)
  case 180:
    return AlyteImageRect(
      x: 1 - local.x - local.width, y: 1 - local.y - local.height,
      width: local.width, height: local.height)
  case 270:
    return AlyteImageRect(
      x: local.y, y: 1 - local.x - local.width, width: local.height, height: local.width)
  default: throw AlyteImageError.malformedRecipe
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
  return UIGraphicsImageRenderer(size: targetSize, format: format).image { context in
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

private func normalizedImage(from data: Data) throws -> UIImage {
  guard let image = UIImage(data: data), image.cgImage != nil else {
    throw AlyteImageError.unreadable
  }
  // Drawing through UIImage normalizes EXIF orientation. The opaque white canvas prevents an
  // alpha channel or an orientation tag from becoming a recoverable source property.
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: image.size))
    image.draw(in: CGRect(origin: .zero, size: image.size))
  }
}

private func loadImage(path: String) throws -> UIImage {
  try normalizedImage(from: Data(contentsOf: URL(fileURLWithPath: alyteImageFilePath(path))))
}

private func cropImage(_ image: UIImage, crop: AlyteImageRect) throws -> UIImage {
  guard let cgImage = image.cgImage else { throw AlyteImageError.renderFailed }
  let width = CGFloat(cgImage.width)
  let height = CGFloat(cgImage.height)
  let rect = CGRect(
    x: crop.x * width,
    y: height - (crop.y + crop.height) * height,
    width: crop.width * width,
    height: crop.height * height
  ).integral.intersection(CGRect(x: 0, y: 0, width: width, height: height))
  guard !rect.isNull, let cropped = cgImage.cropping(to: rect) else {
    throw AlyteImageError.renderFailed
  }
  return UIImage(cgImage: cropped, scale: 1, orientation: .up)
}

private func recipePage(_ recipe: [String: Any]) throws -> (
  crop: AlyteImageRect?, rotation: Int, redactions: [AlyteImageRect]
) {
  guard let pages = bridgeArray(recipe["pages"]), pages.count == 1,
    let page = bridgeDictionary(pages[0]),
    bridgeInteger(page["pageIndex"]) == 0,
    bridgeBoolean(page["selected"]) == true
  else { throw AlyteImageError.malformedRecipe }

  let crop: AlyteImageRect?
  if let value = page["crop"], !(value is NSNull) { crop = try normalizedRect(value) } else { crop = nil }
  let rotation = bridgeInteger(page["rotation"] ?? 0) ?? -1
  guard [0, 90, 180, 270].contains(rotation) else { throw AlyteImageError.malformedRecipe }
  let values = page["redactions"].flatMap(bridgeArray) ?? []
  let redactions = try values.map { value -> AlyteImageRect in
    guard let dictionary = bridgeDictionary(value), dictionary["rect"] != nil else {
      throw AlyteImageError.malformedRecipe
    }
    return try normalizedRect(dictionary["rect"])
  }
  return (crop: crop, rotation: rotation, redactions: redactions)
}

private func renderImage(_ source: UIImage, recipe: [String: Any]) throws -> UIImage {
  let page = try recipePage(recipe)
  var image = page.crop == nil ? source : try cropImage(source, crop: page.crop!)
  image = imageRotated(image, degrees: page.rotation)
  guard !page.redactions.isEmpty else { return image }
  let transformed = try page.redactions.map {
    try transformedRect($0, crop: page.crop, rotation: page.rotation).cgRect
  }
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = true
  return UIGraphicsImageRenderer(size: image.size, format: format).image { context in
    UIColor.white.setFill()
    context.fill(CGRect(origin: .zero, size: image.size))
    image.draw(in: CGRect(origin: .zero, size: image.size))
    UIColor.black.setFill()
    for rect in transformed {
      context.cgContext.fill(CGRect(
        x: rect.minX * image.size.width,
        y: rect.minY * image.size.height,
        width: rect.width * image.size.width,
        height: rect.height * image.size.height))
    }
  }
}

private let userMetadataNames = [
  // JFIF/TIFF technical dictionaries emitted by a fresh ImageIO destination are not user data.
  // The derivative must still reject descriptive EXIF/GPS/IPTC/XMP and profile/comment payloads.
  "gps", "iptc", "makerapple", "8bim", "xmp", "comment", "photoshop",
]

private func hasUserMetadata(_ data: Data) -> Bool {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let properties = bridgeDictionary(CGImageSourceCopyPropertiesAtIndex(source, 0, nil))
  else { return true }
  return properties.keys.contains { key in
    let normalized = key.lowercased().replacingOccurrences(of: "{", with: "")
      .replacingOccurrences(of: "}", with: "")
    // ImageIO may add a technical Exif dictionary and a color ProfileName to a new JPEG. They
    // are safe only when orientation is already physical (1); user-bearing GPS/IPTC/XMP keys
    // still fail through the key check above.
    if normalized == "exif" {
      guard let exif = bridgeDictionary(properties[key]) else { return true }
      let technicalKeys = Set([
        kCGImagePropertyExifPixelXDimension as String,
        kCGImagePropertyExifPixelYDimension as String,
        kCGImagePropertyExifColorSpace as String,
        kCGImagePropertyExifVersion as String,
      ])
      return exif.keys.contains { !technicalKeys.contains($0) }
    }
    if normalized == "profilename" { return false }
    if userMetadataNames.contains(where: { normalized.contains($0) }) { return true }
    // ImageIO may preserve the technical orientation field. It is safe only when the image has
    // already been physically normalized to the upright orientation.
    if normalized.contains("orientation") {
      return (properties[key] as? NSNumber)?.intValue != 1
    }
    return false
  }
}

private struct AlyteImagePixels {
  let width: Int
  let height: Int
  let bytes: [UInt8]

  func pixel(x: Int, y: Int) -> (UInt8, UInt8, UInt8) {
    let offset = (y * width + x) * 4
    return (bytes[offset], bytes[offset + 1], bytes[offset + 2])
  }
}

private func rgbaPixels(_ image: CGImage) -> AlyteImagePixels? {
  let width = image.width
  let height = image.height
  guard width > 0, height > 0 else { return nil }
  var bytes = [UInt8](repeating: 0, count: width * height * 4)
  guard let context = CGContext(
    data: &bytes,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  // Row zero is the top of the image, matching normalized recipe coordinates.
  context.translateBy(x: 0, y: CGFloat(height))
  context.scaleBy(x: 1, y: -1)
  context.interpolationQuality = .none
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  return AlyteImagePixels(width: width, height: height, bytes: bytes)
}

private func imageSource(_ data: Data) throws -> CGImage {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil), image.width > 0, image.height > 0
  else { throw AlyteImageError.verificationFailed(["unreadable-derivative"]) }
  return image
}

private func compareSourceAware(
  actualData: Data,
  expectedImage: UIImage,
  page: (crop: AlyteImageRect?, rotation: Int, redactions: [AlyteImageRect])
) throws -> (sourceAwareChecked: Bool, sourceContentRemoved: Bool, failureReasons: [String]) {
  let actual = try imageSource(actualData)
  guard let expectedPixels = expectedImage.cgImage.flatMap(rgbaPixels),
    let actualPixels = rgbaPixels(actual),
    expectedPixels.width == actualPixels.width,
    expectedPixels.height == actualPixels.height
  else {
    return (false, false, ["source-binding-geometry-mismatch"])
  }

  let width = actualPixels.width
  let height = actualPixels.height
  let stepX = max(1, width / 64)
  let stepY = max(1, height / 64)
  var mismatches = 0
  var compared = 0
  for y in stride(from: 0, to: height, by: stepY) {
    for x in stride(from: 0, to: width, by: stepX) {
      let expected = expectedPixels.pixel(x: x, y: y)
      let actual = actualPixels.pixel(x: x, y: y)
      let error = max(
        abs(Int(expected.0) - Int(actual.0)),
        abs(Int(expected.1) - Int(actual.1)),
        abs(Int(expected.2) - Int(actual.2)))
      compared += 1
      if error > 55 { mismatches += 1 }
    }
  }
  let mismatchLimit = max(2, compared / 100)
  var failures: [String] = []
  if mismatches > mismatchLimit { failures.append("source-binding-pixel-mismatch") }

  var redactionsRemoved = true
  for redaction in page.redactions {
    let output = try transformedRect(redaction, crop: page.crop, rotation: page.rotation)
    // Check a small grid throughout every expected mask, not just its centre. This catches a
    // shifted or partially applied mask even when a source happens to contain a dark centre.
    var samples: [(CGFloat, CGFloat)] = []
    for row in 0..<8 {
      for column in 0..<8 {
        let x = output.minX + output.width * (CGFloat(column) + 0.5) / 8
        let y = output.minY + output.height * (CGFloat(row) + 0.5) / 8
        samples.append((x, y))
      }
    }
    for (x, y) in samples {
      let pixelX = min(width - 1, max(0, Int(x * CGFloat(width))))
      let pixelY = min(height - 1, max(0, Int(y * CGFloat(height))))
      let pixel = actualPixels.pixel(x: pixelX, y: pixelY)
      if max(Int(pixel.0), Int(pixel.1), Int(pixel.2)) > 70 {
        redactionsRemoved = false
        break
      }
    }
    if !redactionsRemoved { break }
  }
  if !redactionsRemoved { failures.append("redaction-pixels-unredacted") }
  return (failures.isEmpty, redactionsRemoved, failures)
}

private func verification(
  _ data: Data,
  sourcePath: String? = nil,
  recipe: [String: Any]? = nil
) throws -> [String: Any] {
  let image = try imageSource(data)
  let metadata = hasUserMetadata(data)
  let reloadChecked = CGImageSourceCreateWithData(data as CFData, nil) != nil
  var reasons = [metadata ? "metadata-or-profile" : nil, reloadChecked ? nil : "reload-failed"]
    .compactMap { $0 }
  var sourceAwareChecked = false
  var sourceContentRemoved = false
  if let sourcePath, let recipe {
    let expected = try renderImage(loadImage(path: sourcePath), recipe: recipe)
    let comparison = try compareSourceAware(
      actualData: data, expectedImage: expected, page: try recipePage(recipe))
    sourceAwareChecked = comparison.sourceAwareChecked
    sourceContentRemoved = comparison.sourceContentRemoved
    reasons.append(contentsOf: comparison.failureReasons)
  }
  return [
    "verified": reasons.isEmpty && sourceAwareChecked,
    "selectableText": false,
    "annotations": false,
    "attachments": false,
    "metadata": metadata,
    "removableRedactions": false,
    "reloadChecked": reloadChecked,
    "sourceAwareChecked": sourceAwareChecked,
    "sourceContentRemoved": sourceContentRemoved,
    "verificationVersion": "image-source-aware-v2",
    "failureReasons": reasons,
    "pixelWidth": image.width,
    "pixelHeight": image.height,
  ]
}

private func encodedImage(_ image: UIImage) throws -> Data {
  guard let cgImage = image.cgImage else { throw AlyteImageError.renderFailed }
  let output = NSMutableData()
  guard let destination = CGImageDestinationCreateWithData(
    output, UTType.jpeg.identifier as CFString, 1, nil)
  else { throw AlyteImageError.renderFailed }
  // A fresh ImageIO destination with no properties is intentional: source EXIF, GPS, comments,
  // ICC profiles, and orientation are not copied into the derivative.
  CGImageDestinationAddImage(destination, cgImage, [
    kCGImageDestinationLossyCompressionQuality: 0.95,
  ] as CFDictionary)
  guard CGImageDestinationFinalize(destination) else { throw AlyteImageError.renderFailed }
  return output as Data
}

private func sanitizeImage(sourcePath: String, destinationPath: String, recipe: [String: Any]) throws
  -> [String: Any]
{
  let image = try renderImage(loadImage(path: sourcePath), recipe: recipe)
  let data = try encodedImage(image)
  let destinationURL = URL(fileURLWithPath: alyteImageFilePath(destinationPath))
  let partialURL = destinationURL.appendingPathExtension("partial")
  defer { try? FileManager.default.removeItem(at: partialURL) }
  try FileManager.default.createDirectory(
    at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  try? FileManager.default.removeItem(at: partialURL)
  try data.write(to: partialURL, options: .atomic)
  let written = try Data(contentsOf: partialURL)
  let facts = try verification(written, sourcePath: sourcePath, recipe: recipe)
  guard facts["verified"] as? Bool == true else {
    throw AlyteImageError.verificationFailed(
      (facts["failureReasons"] as? [String]) ?? ["sanitized-verification-failed"])
  }
  if FileManager.default.fileExists(atPath: destinationURL.path) {
    _ = try FileManager.default.replaceItemAt(destinationURL, withItemAt: partialURL)
  } else {
    try FileManager.default.moveItem(at: partialURL, to: destinationURL)
  }
  return [
    "destinationPath": destinationPath,
    "byteSize": written.count,
    "verification": facts,
  ]
}

#if canImport(ExpoModulesCore)
public final class AlyteImageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlyteImage")

    View(AlyteImageWorkspaceView.self) {
      Prop("sourcePath") { (view: AlyteImageWorkspaceView, path: String) in
        view.sourcePath = alyteImageFilePath(path)
      }
      Prop("redactMode") { (view: AlyteImageWorkspaceView, enabled: Bool) in
        view.redactMode = enabled
      }
      Prop("inspectionMode") { (view: AlyteImageWorkspaceView, enabled: Bool) in
        view.inspectionMode = enabled
      }
      Prop("redactions") { (view: AlyteImageWorkspaceView, redactions: [[String: Any]]) in
        view.setRedactions(redactions)
      }
      Prop("accessibilityLabels") { (view: AlyteImageWorkspaceView, labels: [String: String]) in
        view.setAccessibilityLabels(labels)
      }
      Events("onRedactionsChange", "onReady", "onFailure", "onSelectionChange")
      AsyncFunction("undo") { (view: AlyteImageWorkspaceView) in view.undoEdit() }
      AsyncFunction("redo") { (view: AlyteImageWorkspaceView) in view.redoEdit() }
      AsyncFunction("clearSelection") { (view: AlyteImageWorkspaceView) in view.clearSelection() }
      AsyncFunction("removeSelected") { (view: AlyteImageWorkspaceView) in view.removeSelected() }
    }

    AsyncFunction("inspect") { (path: String) throws -> [String: Any] in
      let data = try Data(contentsOf: URL(fileURLWithPath: alyteImageFilePath(path)))
      guard let image = UIImage(data: data), let cgImage = image.cgImage else {
        throw AlyteImageError.unreadable
      }
      return [
        "width": image.size.width,
        "height": image.size.height,
        "pixelWidth": cgImage.width,
        "pixelHeight": cgImage.height,
        "hasMetadata": hasUserMetadata(data),
      ]
    }

    AsyncFunction("sanitize") {
      (sourcePath: String, destinationPath: String, recipe: [String: Any]) throws -> [String: Any] in
      try sanitizeImage(sourcePath: sourcePath, destinationPath: destinationPath, recipe: recipe)
    }

    AsyncFunction("verifySanitized") {
      (path: String, sourcePath: String, recipe: [String: Any]) throws -> [String: Any] in
      let data = try Data(contentsOf: URL(fileURLWithPath: alyteImageFilePath(path)))
      return try verification(data, sourcePath: sourcePath, recipe: recipe)
    }
  }
}
#endif

public enum AlyteImageSanitizationTestSupport {
  public static func render(sourceURL: URL, destinationURL: URL, recipe: [String: Any]) throws
    -> [String: Any]
  {
    try sanitizeImage(sourcePath: sourceURL.path, destinationPath: destinationURL.path, recipe: recipe)
  }

  public static func verify(url: URL, sourceURL: URL, recipe: [String: Any]) throws -> [String: Any] {
    try verification(Data(contentsOf: url), sourcePath: sourceURL.path, recipe: recipe)
  }
}
