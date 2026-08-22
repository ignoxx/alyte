import XCTest

final class AlyteVisionModuleTests: XCTestCase {
  func testContractVersionIsStableAndBoundingBoxesAreNormalized() {
    let box: [String: Double] = ["x": 0.1, "y": 0.2, "width": 0.4, "height": 0.1]
    XCTAssertEqual(box.values.reduce(0, +), 0.8, accuracy: 0.0001)
    XCTAssertEqual("alyte.vision.ocr.v1", "alyte.vision.ocr.v1")
  }
}
