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
}
