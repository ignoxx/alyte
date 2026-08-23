import CoreGraphics
import XCTest

@testable import AlytePDF

final class AlytePDFWorkspaceTests: XCTestCase {
  func testNormalizedCoordinatesRoundTripAcrossZoomAndPan() {
    let source = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    for frame in [
      CGRect(x: 40, y: 100, width: 320, height: 480),
      CGRect(x: -180, y: -240, width: 960, height: 1440),
      CGRect(x: -900, y: 20, width: 1920, height: 2880),
    ] {
      let view = AlytePDFWorkspaceGeometry.viewRect(normalized: source, pageFrame: frame)
      let result = AlytePDFWorkspaceGeometry.normalizedRect(viewRect: view, pageFrame: frame)
      XCTAssertEqual(result.minX, source.minX, accuracy: 0.000_001)
      XCTAssertEqual(result.minY, source.minY, accuracy: 0.000_001)
      XCTAssertEqual(result.width, source.width, accuracy: 0.000_001)
      XCTAssertEqual(result.height, source.height, accuracy: 0.000_001)
    }
  }

  func testAllRightAngleRotationsRoundTrip() {
    let source = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    for rotation in [0, 90, 180, 270] {
      var value = AlytePDFWorkspaceGeometry.rotated(source, degrees: rotation)
      value = AlytePDFWorkspaceGeometry.rotated(value, degrees: (360 - rotation) % 360)
      XCTAssertEqual(value.minX, source.minX, accuracy: 0.000_001)
      XCTAssertEqual(value.minY, source.minY, accuracy: 0.000_001)
      XCTAssertEqual(value.width, source.width, accuracy: 0.000_001)
      XCTAssertEqual(value.height, source.height, accuracy: 0.000_001)
    }
  }

  func testMoveAccumulatesChangedEventsAndDefersControlledPropsUntilCommit() {
    let original = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    let page = CGRect(x: -180, y: -240, width: 960, height: 1440)
    var session = AlytePDFWorkspaceGestureSession(regions: ["region": original])
    session.begin(id: "region")
    session.change(translation: CGPoint(x: 48, y: 72), pageFrame: page, resize: false)
    session.change(translation: CGPoint(x: 144, y: 216), pageFrame: page, resize: false)
    session.receiveControlled(["region": original])

    XCTAssertEqual(session.activeID, "region")
    let result = session.end(cancelled: false)["region"]!
    XCTAssertEqual(result.minX, 0.27, accuracy: 0.000_001)
    XCTAssertEqual(result.minY, 0.49, accuracy: 0.000_001)
    XCTAssertEqual(session.commitCount, 1)
  }

  func testMoveAndResizeAccumulateInDisplayedAxesForEveryRotation() {
    let source = CGRect(x: 0.2, y: 0.25, width: 0.2, height: 0.1)
    let page = CGRect(x: 20, y: 40, width: 400, height: 600)
    for rotation in [0, 90, 180, 270] {
      var move = AlytePDFWorkspaceGestureSession(regions: ["region": source])
      move.begin(id: "region")
      move.change(
        translation: CGPoint(x: 20, y: 30), pageFrame: page, rotation: rotation, resize: false)
      move.change(
        translation: CGPoint(x: 40, y: 60), pageFrame: page, rotation: rotation, resize: false)
      let moved = move.end(cancelled: false)["region"]!
      let displayedMove = AlytePDFWorkspaceGeometry.rotated(moved, degrees: rotation)
      let displayedSource = AlytePDFWorkspaceGeometry.rotated(source, degrees: rotation)
      XCTAssertEqual(displayedMove.minX, displayedSource.minX + 0.1, accuracy: 0.000_001)
      XCTAssertEqual(displayedMove.minY, displayedSource.minY + 0.1, accuracy: 0.000_001)
      XCTAssertEqual(move.commitCount, 1)

      var resize = AlytePDFWorkspaceGestureSession(regions: ["region": source])
      resize.begin(id: "region")
      resize.change(
        translation: CGPoint(x: 20, y: 30), pageFrame: page, rotation: rotation, resize: true)
      resize.change(
        translation: CGPoint(x: 40, y: 60), pageFrame: page, rotation: rotation, resize: true)
      let resized = resize.end(cancelled: false)["region"]!
      let displayedResize = AlytePDFWorkspaceGeometry.rotated(resized, degrees: rotation)
      XCTAssertEqual(displayedResize.minX, displayedSource.minX, accuracy: 0.000_001)
      XCTAssertEqual(displayedResize.minY, displayedSource.minY, accuracy: 0.000_001)
      XCTAssertEqual(displayedResize.width, displayedSource.width + 0.1, accuracy: 0.000_001)
      XCTAssertEqual(displayedResize.height, displayedSource.height + 0.1, accuracy: 0.000_001)
      XCTAssertEqual(resize.commitCount, 1)

      let boundedMove = AlytePDFWorkspaceGeometry.manipulated(
        original: source, translation: CGPoint(x: 4_000, y: 6_000), pageFrame: page,
        rotation: rotation, resize: false)
      let displayedBound = AlytePDFWorkspaceGeometry.rotated(boundedMove, degrees: rotation)
      XCTAssertEqual(displayedBound.maxX, 1, accuracy: 0.000_001)
      XCTAssertEqual(displayedBound.maxY, 1, accuracy: 0.000_001)

      let minimumResize = AlytePDFWorkspaceGeometry.manipulated(
        original: source, translation: CGPoint(x: -4_000, y: -6_000), pageFrame: page,
        rotation: rotation, resize: true)
      let displayedMinimum = AlytePDFWorkspaceGeometry.rotated(minimumResize, degrees: rotation)
      XCTAssertEqual(displayedMinimum.width, 24 / page.width, accuracy: 0.000_001)
      XCTAssertEqual(displayedMinimum.height, 24 / page.height, accuracy: 0.000_001)
    }
  }

  func testMoveAndResizeStayWithinBoundsAndRespectMinimumViewSize() {
    let page = CGRect(x: -900, y: 20, width: 1920, height: 2880)
    let moved = AlytePDFWorkspaceGeometry.manipulated(
      original: CGRect(x: 0.8, y: 0.8, width: 0.15, height: 0.15),
      translation: CGPoint(x: 2000, y: 3000), pageFrame: page, resize: false)
    XCTAssertEqual(moved.maxX, 1, accuracy: 0.000_001)
    XCTAssertEqual(moved.maxY, 1, accuracy: 0.000_001)

    let resized = AlytePDFWorkspaceGeometry.manipulated(
      original: CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3),
      translation: CGPoint(x: -2000, y: -3000), pageFrame: page, resize: true)
    XCTAssertEqual(resized.width, 24 / page.width, accuracy: 0.000_001)
    XCTAssertEqual(resized.height, 24 / page.height, accuracy: 0.000_001)
  }

  func testCancellationRestoresDeferredControlledValue() {
    let original = CGRect(x: 0.1, y: 0.1, width: 0.2, height: 0.2)
    let controlled = CGRect(x: 0.3, y: 0.3, width: 0.2, height: 0.2)
    var session = AlytePDFWorkspaceGestureSession(regions: ["region": original])
    session.begin(id: "region")
    session.change(
      translation: CGPoint(x: 80, y: 80), pageFrame: CGRect(x: 0, y: 0, width: 400, height: 400),
      resize: false)
    session.receiveControlled(["region": controlled])
    XCTAssertEqual(session.end(cancelled: true)["region"], controlled)
    XCTAssertEqual(session.commitCount, 0)
  }

  func testSelectionReconcilesAfterControlledReplacementAndHistoryChanges() {
    let retained = AlytePDFWorkspaceGeometry.selectionBridgeUpdate(
      current: "selected", requested: "selected", regionIDs: ["selected"])
    XCTAssertEqual(retained.selectedID, "selected")
    XCTAssertFalse(retained.shouldEmit)

    let replaced = AlytePDFWorkspaceGeometry.selectionBridgeUpdate(
      current: "selected", requested: "selected", regionIDs: ["replacement"])
    XCTAssertNil(replaced.selectedID)
    XCTAssertTrue(replaced.shouldEmit)
    XCTAssertFalse(replaced.isSelected)

    let restored = AlytePDFWorkspaceGeometry.selectionBridgeUpdate(
      current: nil, requested: "selected", regionIDs: ["selected"])
    XCTAssertEqual(restored.selectedID, "selected")
    XCTAssertTrue(restored.shouldEmit)
    XCTAssertTrue(restored.isSelected)
  }

  func testFocusedSourceRegionUsesAspectFitAndTransformedPageCoordinates() {
    let source = CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.08)
    let portraitFrame = CGRect(x: 24, y: 80, width: 342, height: 484)
    let focused = AlytePDFWorkspaceGeometry.focusRect(normalized: source)
    let view = AlytePDFWorkspaceGeometry.viewRect(normalized: focused, pageFrame: portraitFrame)
    XCTAssertEqual(view.minX, 30.84, accuracy: 0.000_001)
    XCTAssertEqual(view.minY, 99.36, accuracy: 0.000_001)

    let cropped = CGRect(x: 0.05, y: 0.1, width: 0.8, height: 0.7)
    let withinCrop = CGRect(
      x: (source.minX - cropped.minX) / cropped.width,
      y: (source.minY - cropped.minY) / cropped.height,
      width: source.width / cropped.width,
      height: source.height / cropped.height)
    let rotated = AlytePDFWorkspaceGeometry.rotated(withinCrop, degrees: 90)
    XCTAssertEqual(rotated.minX, 0.742857142857, accuracy: 0.000_001)
    XCTAssertEqual(rotated.minY, 0.0625, accuracy: 0.000_001)
    XCTAssertEqual(rotated.width, 0.114285714286, accuracy: 0.000_001)
    XCTAssertEqual(rotated.height, 0.375, accuracy: 0.000_001)
  }
}
