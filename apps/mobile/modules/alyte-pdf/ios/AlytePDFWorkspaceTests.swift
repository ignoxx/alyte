import CoreGraphics
import XCTest

@testable import AlytePDF

final class AlytePDFWorkspaceTests: XCTestCase {
  func testExistingRedactionsRemainInteractiveOutsideRedactMode() {
    XCTAssertTrue(AlytePDFWorkspaceGeometry.overlayInteractionEnabled(inspectionMode: false))
    XCTAssertFalse(AlytePDFWorkspaceGeometry.overlayInteractionEnabled(inspectionMode: true))
    XCTAssertTrue(
      AlytePDFWorkspaceGeometry.canCreateRedaction(redactMode: true, inspectionMode: false))
    XCTAssertFalse(
      AlytePDFWorkspaceGeometry.canCreateRedaction(redactMode: false, inspectionMode: false))
    XCTAssertFalse(
      AlytePDFWorkspaceGeometry.canCreateRedaction(redactMode: true, inspectionMode: true))
  }

  func testEditGestureIsSingleTouchOnly() {
    XCTAssertEqual(AlytePDFWorkspaceGeometry.editGestureMinimumTouches, 1)
    XCTAssertEqual(AlytePDFWorkspaceGeometry.editGestureMaximumTouches, 1)
  }

  func testGestureLifecycleCancellationRestoresWithoutUndo() {
    let original = CGRect(x: 0.1, y: 0.1, width: 0.2, height: 0.2)
    var lifecycle = AlytePDFWorkspaceGestureLifecycle()
    lifecycle.begin(original: original)
    lifecycle.update(CGRect(x: 0.3, y: 0.3, width: 0.2, height: 0.2))

    XCTAssertEqual(
      lifecycle.finish(cancelled: true),
      AlytePDFWorkspaceGestureResult(rect: original, shouldRecordUndo: false, cancelled: true))
    XCTAssertFalse(lifecycle.isActive)
  }

  func testGestureLifecycleCommitsOneUndoAfterLongCumulativeChange() {
    let original = CGRect(x: 0.1, y: 0.1, width: 0.2, height: 0.2)
    var lifecycle = AlytePDFWorkspaceGestureLifecycle()
    lifecycle.begin(original: original)
    for step in 1...12 {
      lifecycle.update(CGRect(
        x: original.minX + CGFloat(step) * 0.01,
        y: original.minY + CGFloat(step) * 0.01,
        width: original.width,
        height: original.height))
    }

    guard let committed = lifecycle.finish(cancelled: false) else {
      XCTFail("The active gesture should commit")
      return
    }
    XCTAssertEqual(committed.rect.minX, 0.22, accuracy: 0.000_001)
    XCTAssertEqual(committed.rect.minY, 0.22, accuracy: 0.000_001)
    XCTAssertTrue(committed.shouldRecordUndo)
    XCTAssertNil(lifecycle.finish(cancelled: false))
  }

  func testGestureTargetPrioritizesHandleThenBodyAndFailsBlankSpace() {
    let body = AlytePDFWorkspaceOverlayFrame(
      id: "region", frame: CGRect(x: 100, y: 140, width: 160, height: 90), kind: .move)
    let handle = AlytePDFWorkspaceOverlayFrame(
      id: "region", frame: CGRect(x: 216, y: 186, width: 44, height: 44), kind: .resize)

    XCTAssertEqual(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 236, y: 206), overlayFrames: [body, handle]),
      AlytePDFWorkspaceGesture(id: "region", kind: .resize))
    XCTAssertEqual(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 160, y: 170), overlayFrames: [body, handle]),
      AlytePDFWorkspaceGesture(id: "region", kind: .move))
    XCTAssertNil(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 20, y: 20), overlayFrames: [body, handle]))
  }

  func testSmallBodyUsesMinimumTouchTargetButBlankOutsideItFails() {
    let body = AlytePDFWorkspaceOverlayFrame(
      id: "tiny", frame: CGRect(x: 100, y: 100, width: 8, height: 8), kind: .move)

    XCTAssertEqual(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 95, y: 95), overlayFrames: [body]),
      AlytePDFWorkspaceGesture(id: "tiny", kind: .move))
    XCTAssertNil(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 76, y: 76), overlayFrames: [body]))
  }

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

  func testMoveUsesCumulativeTranslationAcrossChangedEvents() {
    let original = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    let page = CGRect(x: -180, y: -240, width: 960, height: 1440)
    let firstChanged = AlytePDFWorkspaceGeometry.manipulated(
      original: original, translation: CGPoint(x: 48, y: 72), pageFrame: page, resize: false)
    let finalChanged = AlytePDFWorkspaceGeometry.manipulated(
      original: original, translation: CGPoint(x: 144, y: 216), pageFrame: page, resize: false)

    XCTAssertGreaterThan(finalChanged.minX, firstChanged.minX)
    XCTAssertGreaterThan(finalChanged.minY, firstChanged.minY)
    XCTAssertEqual(finalChanged.minX, 0.27, accuracy: 0.000_001)
    XCTAssertEqual(finalChanged.minY, 0.49, accuracy: 0.000_001)
  }

  func testMoveAndResizeAccumulateInDisplayedAxesForEveryRotation() {
    let source = CGRect(x: 0.2, y: 0.25, width: 0.2, height: 0.1)
    let page = CGRect(x: 20, y: 40, width: 400, height: 600)
    for rotation in [0, 90, 180, 270] {
      let moved = AlytePDFWorkspaceGeometry.manipulated(
        original: source,
        translation: CGPoint(x: 20, y: 30), pageFrame: page, rotation: rotation, resize: false)
      let finalMoved = AlytePDFWorkspaceGeometry.manipulated(
        original: source,
        translation: CGPoint(x: 40, y: 60), pageFrame: page, rotation: rotation, resize: false)
      let displayedMove = AlytePDFWorkspaceGeometry.rotated(finalMoved, degrees: rotation)
      let displayedSource = AlytePDFWorkspaceGeometry.rotated(source, degrees: rotation)
      XCTAssertGreaterThan(
        displayedMove.minX,
        AlytePDFWorkspaceGeometry.rotated(moved, degrees: rotation).minX)
      XCTAssertEqual(displayedMove.minX, displayedSource.minX + 0.1, accuracy: 0.000_001)
      XCTAssertEqual(displayedMove.minY, displayedSource.minY + 0.1, accuracy: 0.000_001)

      let resized = AlytePDFWorkspaceGeometry.manipulated(
        original: source,
        translation: CGPoint(x: 20, y: 30), pageFrame: page, rotation: rotation, resize: true)
      let finalResized = AlytePDFWorkspaceGeometry.manipulated(
        original: source,
        translation: CGPoint(x: 40, y: 60), pageFrame: page, rotation: rotation, resize: true)
      let displayedResize = AlytePDFWorkspaceGeometry.rotated(finalResized, degrees: rotation)
      XCTAssertEqual(displayedResize.minX, displayedSource.minX, accuracy: 0.000_001)
      XCTAssertEqual(displayedResize.minY, displayedSource.minY, accuracy: 0.000_001)
      XCTAssertEqual(displayedResize.width, displayedSource.width + 0.1, accuracy: 0.000_001)
      XCTAssertEqual(displayedResize.height, displayedSource.height + 0.1, accuracy: 0.000_001)

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
