import Foundation
import ImageIO
import UIKit
import XCTest

@testable import AlyteImage

final class AlyteImageModuleTests: XCTestCase {
  func testSanitizationNormalizesOrientationAndRemovesMetadata() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-image-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let source = directory.appendingPathComponent("source.jpg")
    let destination = directory.appendingPathComponent("sanitized.jpg")
    let sourceData = NSMutableData()
    let sourceDestination = try XCTUnwrap(
      CGImageDestinationCreateWithData(sourceData, "public.jpeg" as CFString, 1, nil))
    let image = try XCTUnwrap(UIImage(color: .white, size: CGSize(width: 400, height: 300)).cgImage)
    CGImageDestinationAddImage(sourceDestination, image, [
      kCGImagePropertyOrientation: 6,
      kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "SYNTHETIC-PRIVATE"],
      kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 54.7],
    ] as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(sourceDestination))
    try sourceData.write(to: source)

    let recipe: [String: Any] = ["pages": [[
      "pageIndex": 0,
      "selected": true,
      "crop": NSNull(),
      "rotation": 0,
      "redactions": [["rect": ["x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2]]],
    ]]]
    let rendered = try AlyteImageSanitizationTestSupport.render(
      sourceURL: source, destinationURL: destination, recipe: recipe)
    let facts = try XCTUnwrap(rendered["verification"] as? [String: Any])
    XCTAssertEqual(facts["verified"] as? Bool, true)
    XCTAssertEqual(facts["metadata"] as? Bool, false)
    XCTAssertEqual(facts["sourceContentRemoved"] as? Bool, true)
    XCTAssertTrue(FileManager.default.fileExists(atPath: destination.path))

    let reloaded = try AlyteImageSanitizationTestSupport.verify(
      url: destination, sourceURL: source, recipe: recipe)
    XCTAssertEqual(reloaded["verified"] as? Bool, true)
    XCTAssertEqual(reloaded["metadata"] as? Bool, false)
  }

  func testInvalidImageRecipeDoesNotLeavePartialArtifact() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-image-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = directory.appendingPathComponent("source.jpg")
    let destination = directory.appendingPathComponent("sanitized.jpg")
    try XCTUnwrap(UIImage(color: .white, size: CGSize(width: 100, height: 100)).jpegData(compressionQuality: 1))
      .write(to: source)

    let recipe: [String: Any] = ["pages": [[
      "pageIndex": 1,
      "selected": true,
      "crop": NSNull(),
      "rotation": 0,
      "redactions": [],
    ]]]
    XCTAssertThrowsError(try AlyteImageSanitizationTestSupport.render(
      sourceURL: source, destinationURL: destination, recipe: recipe))
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathExtension("partial").path))
  }
}

private extension UIImage {
  convenience init?(color: UIColor, size: CGSize) {
    UIGraphicsBeginImageContextWithOptions(size, true, 1)
    defer { UIGraphicsEndImageContext() }
    color.setFill()
    UIRectFill(CGRect(origin: .zero, size: size))
    guard let image = UIGraphicsGetImageFromCurrentImageContext()?.cgImage else { return nil }
    self.init(cgImage: image)
  }
}
