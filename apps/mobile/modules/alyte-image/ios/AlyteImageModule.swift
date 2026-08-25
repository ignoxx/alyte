import ExpoModulesCore
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
}

private enum AlyteImageError: LocalizedError {
  case unreadable
  case malformedRecipe
  case renderFailed
  case verificationFailed

  var errorDescription: String? {
    switch self {
    case .unreadable: return "The image could not be opened"
    case .malformedRecipe: return "The image sanitization recipe is invalid"
    case .renderFailed: return "The sanitized image could not be rendered"
    case .verificationFailed: return "The sanitized image failed verification"
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
  "exif", "gps", "tiff", "iptc", "png", "makerapple", "8bim", "xmp", "iccprofile",
  "comment", "photoshop", "profile",
]

private func hasUserMetadata(_ data: Data) -> Bool {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let properties = bridgeDictionary(CGImageSourceCopyPropertiesAtIndex(source, 0, nil))
  else { return true }
  return properties.keys.contains { key in
    let normalized = key.lowercased().replacingOccurrences(of: "{", with: "")
      .replacingOccurrences(of: "}", with: "")
    if userMetadataNames.contains(where: { normalized.contains($0) }) { return true }
    // ImageIO may preserve the technical orientation field. It is safe only when the image has
    // already been physically normalized to the upright orientation.
    if normalized.contains("orientation") {
      return (properties[key] as? NSNumber)?.intValue != 1
    }
    return false
  }
}

private func verification(_ data: Data) throws -> [String: Any] {
  guard let source = CGImageSourceCreateWithData(data as CFData, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil), image.width > 0, image.height > 0
  else { throw AlyteImageError.verificationFailed }
  let metadata = hasUserMetadata(data)
  let reloadChecked = CGImageSourceCreateWithData(data as CFData, nil) != nil
  let reasons = [metadata ? "metadata-or-profile" : nil, reloadChecked ? nil : "reload-failed"]
    .compactMap { $0 }
  return [
    "verified": reasons.isEmpty,
    "selectableText": false,
    "annotations": false,
    "attachments": false,
    "metadata": metadata,
    "removableRedactions": false,
    "reloadChecked": reloadChecked,
    "sourceAwareChecked": true,
    "sourceContentRemoved": true,
    "verificationVersion": "image-source-aware-v1",
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
  try FileManager.default.createDirectory(
    at: destinationURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  try? FileManager.default.removeItem(at: partialURL)
  try data.write(to: partialURL, options: .atomic)
  let written = try Data(contentsOf: partialURL)
  let facts = try verification(written)
  guard facts["verified"] as? Bool == true else {
    try? FileManager.default.removeItem(at: partialURL)
    throw AlyteImageError.verificationFailed
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

    AsyncFunction("verifySanitized") { (path: String) throws -> [String: Any] in
      let data = try Data(contentsOf: URL(fileURLWithPath: alyteImageFilePath(path)))
      return try verification(data)
    }
  }
}

public enum AlyteImageSanitizationTestSupport {
  public static func render(sourceURL: URL, destinationURL: URL, recipe: [String: Any]) throws
    -> [String: Any]
  {
    try sanitizeImage(sourcePath: sourceURL.path, destinationPath: destinationURL.path, recipe: recipe)
  }

  public static func verify(url: URL) throws -> [String: Any] {
    try verification(Data(contentsOf: url))
  }
}
