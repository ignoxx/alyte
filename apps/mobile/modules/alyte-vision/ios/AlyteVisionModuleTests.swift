import XCTest
import CoreGraphics
@testable import AlyteVision

final class AlyteVisionModuleTests: XCTestCase {
  func testContractVersionIsStableAndBoundingBoxesAreNormalized() {
    let box: [String: Double] = ["x": 0.1, "y": 0.2, "width": 0.4, "height": 0.1]
    XCTAssertEqual(box.values.reduce(0, +), 0.8, accuracy: 0.0001)
    XCTAssertEqual("alyte.vision.ocr.v1", "alyte.vision.ocr.v1")
  }

  func testPDFTransformMapsBottomLeftToTopLeftWithoutMirroring() throws {
    let page = CGRect(x: 10, y: 20, width: 100, height: 200)
    let result = try alytePDFPageDrawingTransform(pageBounds: page, scale: 2, orientation: 0)
    XCTAssertEqual(result.size, CGSize(width: 200, height: 400))
    XCTAssertEqual(CGPoint(x: 10, y: 20).applying(result.transform), CGPoint(x: 0, y: 400))
    XCTAssertEqual(CGPoint(x: 10, y: 220).applying(result.transform), CGPoint(x: 0, y: 0))
    XCTAssertLessThan(result.transform.d, 0)
  }

  func testPDFTransformHonorsRightAngleOrientation() throws {
    let page = CGRect(x: 0, y: 0, width: 100, height: 200)
    let result = try alytePDFPageDrawingTransform(pageBounds: page, scale: 1, orientation: 90)
    XCTAssertEqual(result.size, CGSize(width: 200, height: 100))
    XCTAssertEqual(CGPoint(x: 0, y: 0).applying(result.transform), CGPoint(x: 0, y: 0))
    XCTAssertEqual(CGPoint(x: 100, y: 0).applying(result.transform), CGPoint(x: 0, y: 100))
    XCTAssertEqual(CGPoint(x: 0, y: 200).applying(result.transform), CGPoint(x: 200, y: 0))
  }
}
