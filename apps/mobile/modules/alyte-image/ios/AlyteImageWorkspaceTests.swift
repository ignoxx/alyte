import CoreGraphics
import XCTest

@testable import AlyteImage

final class AlyteImageWorkspaceTests: XCTestCase {
  func testNormalizedCoordinatesRemainStableAcrossZoomAndPan() {
    let source = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    for frame in [
      CGRect(x: 0, y: 0, width: 320, height: 480),
      CGRect(x: 0, y: 0, width: 1280, height: 1920),
    ] {
      let view = AlyteImageWorkspaceGeometry.viewRect(normalized: source, pageFrame: frame)
      let result = AlyteImageWorkspaceGeometry.normalizedRect(viewRect: view, pageFrame: frame)
      XCTAssertEqual(result.minX, source.minX, accuracy: 0.000_001)
      XCTAssertEqual(result.minY, source.minY, accuracy: 0.000_001)
      XCTAssertEqual(result.width, source.width, accuracy: 0.000_001)
      XCTAssertEqual(result.height, source.height, accuracy: 0.000_001)
    }
  }

  func testMoveAndResizeUseTheDisplayedImageAxesAndStayInBounds() {
    let frame = CGRect(x: 0, y: 0, width: 1200, height: 1800)
    let original = CGRect(x: 0.2, y: 0.25, width: 0.2, height: 0.1)
    let moved = AlyteImageWorkspaceGeometry.manipulated(
      original: original, translation: CGPoint(x: 120, y: 180), pageFrame: frame, resize: false)
    XCTAssertEqual(moved.minX, 0.3, accuracy: 0.000_001)
    XCTAssertEqual(moved.minY, 0.35, accuracy: 0.000_001)

    let resized = AlyteImageWorkspaceGeometry.manipulated(
      original: original, translation: CGPoint(x: 120, y: 180), pageFrame: frame, resize: true)
    XCTAssertEqual(resized.width, 0.3, accuracy: 0.000_001)
    XCTAssertEqual(resized.height, 0.2, accuracy: 0.000_001)

    let bounded = AlyteImageWorkspaceGeometry.manipulated(
      original: original, translation: CGPoint(x: 10_000, y: 10_000), pageFrame: frame, resize: false)
    XCTAssertEqual(bounded.maxX, 1, accuracy: 0.000_001)
    XCTAssertEqual(bounded.maxY, 1, accuracy: 0.000_001)
  }
}
