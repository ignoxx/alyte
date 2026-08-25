import Foundation
import ImageIO
import XCTest
import UIKit
import UniformTypeIdentifiers
@testable import AlyteImagePrivacy

final class ImagePrivacyTests: XCTestCase {
  private func temporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-image-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func sourceImage() throws -> URL {
    let url = try temporaryDirectory().appendingPathComponent("source.jpg")
    let image = UIGraphicsImageRenderer(size: CGSize(width: 160, height: 100)).image { context in
      UIColor.systemRed.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 80, height: 50))
      UIColor.systemBlue.setFill()
      context.fill(CGRect(x: 80, y: 0, width: 80, height: 50))
      UIColor.systemGreen.setFill()
      context.fill(CGRect(x: 0, y: 50, width: 80, height: 50))
      UIColor.systemYellow.setFill()
      context.fill(CGRect(x: 80, y: 50, width: 80, height: 50))
      UIColor.black.setFill()
      context.fill(CGRect(x: 16, y: 10, width: 32, height: 16))
    }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
      output, UTType.jpeg.identifier as CFString, 1, nil),
      let cgImage = image.cgImage
    else { throw NSError(domain: "AlyteImageTests", code: 1) }
    // Orientation 6 and GPS are deliberately synthetic privacy-bearing metadata. The renderer
    // must normalize the pixels and omit both from the derivative.
    CGImageDestinationAddImage(destination, cgImage, [
      kCGImagePropertyOrientation: 6,
      kCGImagePropertyGPSDictionary: [
        kCGImagePropertyGPSLatitude: 51.0,
        kCGImagePropertyGPSLongitude: 13.0,
      ],
    ] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw NSError(domain: "AlyteImageTests", code: 2)
    }
    try (output as Data).write(to: url)
    return url
  }

  private func recipe(redactions: [[String: Any]]) -> [String: Any] {
    [
      "reportId": "synthetic-report",
      "pages": [[
        "pageIndex": 0,
        "selected": true,
        "rotation": 90,
        "crop": NSNull(),
        "redactions": redactions,
      ]],
    ]
  }

  private func redaction() -> [String: Any] {
    [
      "id": "marker",
      "rect": ["x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0],
    ]
  }

  func testOrientationMetadataAndRedactionPixelsAreSourceAware() throws {
    let source = try sourceImage()
    let destination = try temporaryDirectory().appendingPathComponent("derivative.jpg")
    let result = try AlyteImageSanitizationTestSupport.render(
      sourceURL: source, destinationURL: destination, recipe: recipe(redactions: [redaction()]))
    let facts = result["verification"] as? [String: Any] ?? [:]

    XCTAssertEqual(facts["verified"] as? Bool, true)
    XCTAssertEqual(facts["sourceAwareChecked"] as? Bool, true)
    XCTAssertEqual(facts["sourceContentRemoved"] as? Bool, true)
    XCTAssertEqual(facts["metadata"] as? Bool, false)
    XCTAssertEqual(facts["verificationVersion"] as? String, "image-source-aware-v2")
    XCTAssertGreaterThan(facts["pixelWidth"] as? Int ?? 0, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathExtension("partial").path))
  }

  func testTamperedOrUnredactedDerivativeFailsClosed() throws {
    let source = try sourceImage()
    let unredacted = try temporaryDirectory().appendingPathComponent("unredacted.jpg")
    _ = try AlyteImageSanitizationTestSupport.render(
      sourceURL: source, destinationURL: unredacted, recipe: recipe(redactions: []))
    let facts = try AlyteImageSanitizationTestSupport.verify(
      url: unredacted, sourceURL: source, recipe: recipe(redactions: [redaction()]))
    XCTAssertEqual(facts["verified"] as? Bool, false)
    let failures = facts["failureReasons"] as? [String] ?? []
    XCTAssertTrue(failures.contains("redaction-pixels-unredacted"))

    var bytes = try Data(contentsOf: unredacted)
    bytes[bytes.count / 2] ^= 0xFF
    try bytes.write(to: unredacted)
    let tampered = try AlyteImageSanitizationTestSupport.verify(
      url: unredacted, sourceURL: source, recipe: recipe(redactions: []))
    XCTAssertEqual(tampered["verified"] as? Bool, false)
    XCTAssertTrue((tampered["failureReasons"] as? [String] ?? []).contains("source-binding-pixel-mismatch"))
  }

  func testPartialIsRemovedWhenFinalPromotionFails() throws {
    let source = try sourceImage()
    let destination = try temporaryDirectory().appendingPathComponent("blocked.jpg")
    try Data("not-a-directory".utf8).write(to: destination)
    let blockedDestination = destination.appendingPathComponent("output.jpg")
    XCTAssertThrowsError(try AlyteImageSanitizationTestSupport.render(
      sourceURL: source, destinationURL: blockedDestination, recipe: recipe(redactions: [redaction()])))
    XCTAssertFalse(FileManager.default.fileExists(atPath: blockedDestination.appendingPathExtension("partial").path))
  }
}
