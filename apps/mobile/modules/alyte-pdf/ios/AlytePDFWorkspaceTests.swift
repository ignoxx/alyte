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
    session.change(translation: CGPoint(x: 80, y: 80), pageFrame: CGRect(x: 0, y: 0, width: 400, height: 400), resize: false)
    session.receiveControlled(["region": controlled])
    XCTAssertEqual(session.end(cancelled: true)["region"], controlled)
  }
}
