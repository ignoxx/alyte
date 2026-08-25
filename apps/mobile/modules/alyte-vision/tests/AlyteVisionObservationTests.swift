import CoreGraphics
import UIKit
import Vision
import XCTest
@testable import AlyteVisionBoundary

final class AlyteVisionObservationTests: XCTestCase {
  func testAdapterSplitsDistinctVisionLinesWithStableIDsAndExactRegions() async throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 900)).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 900, height: 900))
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 38),
        .foregroundColor: UIColor.black,
      ]
      NSString(string: "LDL-C 3,8 mmol/L").draw(at: CGPoint(x: 60, y: 120), withAttributes: attributes)
      NSString(string: "HDL-C 1,4 mmol/L").draw(at: CGPoint(x: 60, y: 330), withAttributes: attributes)
      NSString(string: "Triglycerides 1,2 mmol/L").draw(at: CGPoint(x: 60, y: 540), withAttributes: attributes)
    }
    var request = RecognizeDocumentsRequest()
    request.textRecognitionOptions.automaticallyDetectLanguage = true
    request.textRecognitionOptions.maximumCandidateCount = 5
    let documents = try await request.perform(on: image.cgImage!, orientation: .up)
    let lines = documents.flatMap { $0.document.text.lines }
      .filter { $0.transcript.contains("LDL") || $0.transcript.contains("HDL") || $0.transcript.contains("Triglycerides") }
    XCTAssertGreaterThanOrEqual(lines.count, 3)
    let selected = Array(lines.prefix(3))
    let region = selected.map { $0.boundingBox.cgRect }.reduce(CGRect.null) { $0.union($1) }

    let output = alyteDocumentObservations(
      id: "document-0-line-source",
      text: selected.map(\.transcript).joined(separator: "\n"),
      box: region,
      pageIndex: 0,
      orientation: 0,
      structure: ["kind": "text", "tableId": NSNull(), "rowIndex": NSNull(), "columnIndex": NSNull()],
      lines: selected
    )

    XCTAssertEqual(output.count, selected.count)
    XCTAssertEqual(output.map { $0["id"] as? String }, [
      "document-0-line-source-line-0",
      "document-0-line-source-line-1",
      "document-0-line-source-line-2",
    ])
    XCTAssertEqual(output.map { $0["text"] as? String }, selected.map(\.transcript))
    let outputBoxes = output.compactMap { $0["boundingBox"] as? [String: Double] }
    XCTAssertEqual(outputBoxes.count, selected.count)
    for (outputBox, line) in zip(outputBoxes, selected) {
      let sourceBox = line.boundingBox.cgRect
      XCTAssertEqual(outputBox["x"] ?? -1, Double(sourceBox.minX), accuracy: 0.000001)
      XCTAssertEqual(outputBox["y"] ?? -1, Double(1 - sourceBox.maxY), accuracy: 0.000001)
      XCTAssertEqual(outputBox["width"] ?? -1, Double(sourceBox.width), accuracy: 0.000001)
      XCTAssertEqual(outputBox["height"] ?? -1, Double(sourceBox.height), accuracy: 0.000001)
    }
    XCTAssertEqual(output.map { $0["structure"] as? [String: Any] }.compactMap { $0?["kind"] as? String }, ["text", "text", "text"])
  }

  func testAdapterKeepsOriginalObservationWhenLineGeometryCannotBeProvenSafe() async throws {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 600)).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 600, height: 600))
      let attributes: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: 36),
        .foregroundColor: UIColor.black,
      ]
      NSString(string: "LDL-C 3,8 mmol/L").draw(at: CGPoint(x: 40, y: 80), withAttributes: attributes)
      NSString(string: "HDL-C 1,4 mmol/L").draw(at: CGPoint(x: 40, y: 260), withAttributes: attributes)
    }
    var request = RecognizeDocumentsRequest()
    request.textRecognitionOptions.maximumCandidateCount = 5
    let documents = try await request.perform(on: image.cgImage!, orientation: .up)
    let lines = documents.flatMap { $0.document.text.lines }
    XCTAssertGreaterThanOrEqual(lines.count, 2)
    let sourceText = lines.prefix(2).map(\.transcript).joined(separator: "\n")
    let output = alyteDocumentObservations(
      id: "document-0-unsafe-source",
      text: sourceText,
      box: CGRect(x: 0, y: 0, width: 0.01, height: 0.01),
      pageIndex: 0,
      orientation: 0,
      structure: ["kind": "table-cell", "tableId": "table-0", "rowIndex": 2, "columnIndex": 0],
      lines: Array(lines.prefix(2))
    )

    XCTAssertEqual(output.count, 1)
    XCTAssertEqual(output[0]["id"] as? String, "document-0-unsafe-source")
    XCTAssertEqual(output[0]["text"] as? String, sourceText)
    XCTAssertEqual((output[0]["structure"] as? [String: Any])?["kind"] as? String, "table-cell")
  }
}
