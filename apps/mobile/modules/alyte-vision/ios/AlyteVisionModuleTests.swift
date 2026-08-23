import XCTest
import CoreGraphics
import PDFKit
import UIKit
import Vision
@testable import AlyteVision

final class AlyteVisionModuleTests: XCTestCase {
  func testContractVersionIsStableAndBoundingBoxesAreNormalized() {
    let box: [String: Double] = ["x": 0.1, "y": 0.2, "width": 0.4, "height": 0.1]
    XCTAssertEqual(box.values.reduce(0, +), 0.8, accuracy: 0.0001)
    XCTAssertEqual(alyteVisionContractVersion, "alyte.vision.document.v2")
  }

  func testPDFImageKeepsPDFKitRenderingAtZeroOrientation() throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 200)).image { context in
      UIColor.black.setFill()
      context.fill(CGRect(x: 10, y: 20, width: 30, height: 40))
    }
    let result = try alyteRotatedPDFImage(image, orientation: 0)
    XCTAssertTrue(result === image)
    XCTAssertEqual(result.size, CGSize(width: 100, height: 200))
  }

  func testPDFImageHonorsRightAngleOrientation() throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 200)).image { _ in }
    XCTAssertEqual(try alyteRotatedPDFImage(image, orientation: 90).size, CGSize(width: 200, height: 100))
    XCTAssertEqual(try alyteRotatedPDFImage(image, orientation: 180).size, CGSize(width: 100, height: 200))
    XCTAssertEqual(try alyteRotatedPDFImage(image, orientation: 270).size, CGSize(width: 200, height: 100))
    XCTAssertThrowsError(try alyteRotatedPDFImage(image, orientation: 45))
  }

  func testPDFKitRasterProducesStructuredDocumentObservationsForSyntheticLabText() async throws {
    let source = UIGraphicsImageRenderer(size: CGSize(width: 596, height: 842)).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 596, height: 842))
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 18),
        .foregroundColor: UIColor.black,
      ]
      NSString(string: "Synthetic Laboratory\nCollection date 20.08.2026\nLDL cholesterol       118 mg/dL       < 115\nLicence 0000")
        .draw(at: CGPoint(x: 48, y: 80), withAttributes: attributes)
    }
    let document = PDFDocument()
    document.insert(PDFPage(image: source)!, at: 0)
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-vision-synthetic-\(UUID().uuidString).pdf")
    defer { try? FileManager.default.removeItem(at: url) }
    XCTAssertTrue(document.write(to: url))

    let image = try renderedImage(path: url.path, pageIndex: 0, orientation: 0, password: nil)
    var request = RecognizeDocumentsRequest()
    request.textRecognitionOptions.automaticallyDetectLanguage = true
    request.textRecognitionOptions.maximumCandidateCount = 5
    let documents = try await request.perform(on: image, orientation: .up)

    XCTAssertFalse(documents.isEmpty)
    XCTAssertTrue(documents.flatMap { $0.document.text.lines }.contains {
      $0.transcript.contains("LDL")
    })
  }
}
