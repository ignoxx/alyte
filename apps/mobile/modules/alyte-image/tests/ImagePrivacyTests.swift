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

  func testFocusRegionExpandsAndStaysWithinNormalizedImageBounds() {
    let source = CGRect(x: 0.42, y: 0.46, width: 0.08, height: 0.03)
    let focused = AlyteImageWorkspaceGeometry.focusRect(normalized: source)
    XCTAssertLessThanOrEqual(focused.minX, source.minX)
    XCTAssertLessThanOrEqual(focused.minY, source.minY)
    XCTAssertGreaterThanOrEqual(focused.maxX, source.maxX)
    XCTAssertGreaterThanOrEqual(focused.maxY, source.maxY)
    XCTAssertGreaterThanOrEqual(focused.minX, 0)
    XCTAssertGreaterThanOrEqual(focused.minY, 0)
    XCTAssertLessThanOrEqual(focused.maxX, 1)
    XCTAssertLessThanOrEqual(focused.maxY, 1)
  }

  func testAspectFitViewportCentersPortraitAndLandscapeImages() {
    let portrait = AlyteImageWorkspaceGeometry.aspectFit(
      imageSize: CGSize(width: 900, height: 1600), viewportSize: CGSize(width: 390, height: 720))
    XCTAssertEqual(portrait.scale, 0.4333333333, accuracy: 0.000001)
    XCTAssertEqual(portrait.displayedSize.width, 390, accuracy: 0.000001)
    XCTAssertEqual(portrait.displayedSize.height, 693.3333333, accuracy: 0.000001)
    XCTAssertEqual(portrait.insets.top, 13.3333333, accuracy: 0.000001)
    XCTAssertEqual(portrait.insets.left, 0, accuracy: 0.000001)

    let landscape = AlyteImageWorkspaceGeometry.aspectFit(
      imageSize: CGSize(width: 1920, height: 1440), viewportSize: CGSize(width: 390, height: 720))
    XCTAssertEqual(landscape.scale, 0.203125, accuracy: 0.000001)
    XCTAssertEqual(landscape.displayedSize.width, 390, accuracy: 0.000001)
    XCTAssertEqual(landscape.displayedSize.height, 292.5, accuracy: 0.000001)
    XCTAssertEqual(landscape.insets.top, 213.75, accuracy: 0.000001)
    XCTAssertEqual(landscape.insets.left, 0, accuracy: 0.000001)
  }

  func testMoveAndResizeGestureStateStayExplicitAndCannotMutateInspectionMode() {
    var state = AlyteImageWorkspaceInteractionState(selectedID: "region-1")
    XCTAssertTrue(state.beginGesture(id: "region-1", kind: .move))
    XCTAssertEqual(state.activeGesture, AlyteImageWorkspaceGesture(id: "region-1", kind: .move))
    state.endGesture()
    XCTAssertNil(state.activeGesture)
    XCTAssertTrue(state.beginGesture(id: "region-1", kind: .resize))
    XCTAssertEqual(state.activeGesture?.kind, .resize)
    state.setInspectionMode(true)
    XCTAssertNil(state.activeGesture)
    XCTAssertFalse(state.beginGesture(id: "region-1", kind: .move))
  }

  func testInspectionModeClearsSelectionAndBlocksMutationSelection() {
    var state = AlyteImageWorkspaceInteractionState(selectedID: "region-1")
    XCTAssertTrue(state.allowsMutation)
    state.setInspectionMode(true)
    XCTAssertFalse(state.allowsMutation)
    XCTAssertNil(state.selectedID)
    state.select("region-2")
    XCTAssertNil(state.selectedID)
    state.setInspectionMode(false)
    state.select("region-2")
    XCTAssertEqual(state.selectedID, "region-2")
  }

  func testLandscapePhotosSamplePassesSourceAwareVerification() throws {
    let source = try temporaryDirectory().appendingPathComponent("landscape.jpg")
    let destination = try temporaryDirectory().appendingPathComponent("landscape-sanitized.jpg")
    let image = UIGraphicsImageRenderer(size: CGSize(width: 1920, height: 1440)).image { context in
      UIColor.systemRed.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 960, height: 720))
      UIColor.systemBlue.setFill()
      context.fill(CGRect(x: 960, y: 0, width: 960, height: 720))
      UIColor.systemGreen.setFill()
      context.fill(CGRect(x: 0, y: 720, width: 960, height: 720))
      UIColor.systemYellow.setFill()
      context.fill(CGRect(x: 960, y: 720, width: 960, height: 720))
      UIColor.black.setFill()
      context.fill(CGRect(x: 64, y: 120, width: 300, height: 120))
      context.fill(CGRect(x: 1660, y: 920, width: 160, height: 260))
    }
    try XCTUnwrap(image.jpegData(compressionQuality: 0.9)).write(to: source)
    let recipe: [String: Any] = ["pages": [[
      "pageIndex": 0,
      "selected": true,
      "crop": NSNull(),
      "rotation": 0,
      "redactions": [["rect": ["x": 0.36, "y": 0.2, "width": 0.12, "height": 0.16]]],
    ]]]
    let result = try AlyteImageSanitizationTestSupport.render(
      sourceURL: source, destinationURL: destination, recipe: recipe)
    let facts = try XCTUnwrap(result["verification"] as? [String: Any])
    XCTAssertEqual(facts["verified"] as? Bool, true, "\(facts)")
  }
}
