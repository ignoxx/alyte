import CoreGraphics
import UIKit
import Vision
import XCTest
@testable import AlyteVisionBoundary

final class AlyteVisionObservationTests: XCTestCase {
  func testTokenSpansUseExactUTF16OffsetsAndDeterministicParentLinkedIDs() {
    let text = "Žmogus 🔬 LDL 3,8 mmol/L"
    let candidates = [
      AlyteVisionTokenCandidate(text: "LDL", boundingBox: CGRect(x: 0.10, y: 0.20, width: 0.15, height: 0.04)),
      AlyteVisionTokenCandidate(text: "3,8", boundingBox: CGRect(x: 0.30, y: 0.20, width: 0.12, height: 0.04)),
    ]

    let first = alyteExactTokenSpans(
      parentObservationId: "document-0-line-1",
      text: text,
      candidates: candidates
    )
    let second = alyteExactTokenSpans(
      parentObservationId: "document-0-line-1",
      text: text,
      candidates: candidates
    )

    XCTAssertEqual(first?.map { $0["id"] as? String }, second?.map { $0["id"] as? String })
    XCTAssertEqual(first?.count, 2)
    let ldl = first?[0]
    let decimal = first?[1]
    XCTAssertEqual(ldl?["parentObservationId"] as? String, "document-0-line-1")
    XCTAssertEqual(ldl?["text"] as? String, "LDL")
    XCTAssertEqual(ldl?["start"] as? Int, (text as NSString).range(of: "LDL").location)
    XCTAssertEqual(ldl?["end"] as? Int, (text as NSString).range(of: "LDL").location + 3)
    XCTAssertEqual(decimal?["text"] as? String, "3,8")
    XCTAssertEqual(decimal?["start"] as? Int, (text as NSString).range(of: "3,8").location)
    XCTAssertEqual(decimal?["end"] as? Int, (text as NSString).range(of: "3,8").location + 3)
    XCTAssertEqual(ldl?["id"] as? String, "document-0-line-1-span-10-13")
  }

  func testTokenSpansRetainOnlyExactParentSubstringsAndNormalizedGeometry() {
    let spans = alyteExactTokenSpans(
      parentObservationId: "parent",
      text: "LDL 3,8 mmol/L",
      candidates: [
        AlyteVisionTokenCandidate(text: "LDL", boundingBox: CGRect(x: -0.2, y: 0.1, width: 1.4, height: 0.3)),
        AlyteVisionTokenCandidate(text: "3,8", boundingBox: .zero),
        AlyteVisionTokenCandidate(text: "mmol/L", boundingBox: CGRect(x: 0.7, y: 0.1, width: 0.2, height: 0.3)),
      ]
    )

    XCTAssertEqual(spans?.count, 2)
    XCTAssertEqual(spans?[0]["text"] as? String, "LDL")
    XCTAssertEqual(spans?[1]["text"] as? String, "mmol/L")
    let box = spans?[0]["boundingBox"] as? [String: Double]
    XCTAssertEqual(box?["x"] ?? -1, 0, accuracy: 0.000001)
    XCTAssertEqual(box?["y"] ?? -1, 0.6, accuracy: 0.000001)
    XCTAssertEqual(box?["width"] ?? -1, 1, accuracy: 0.000001)
    XCTAssertEqual(box?["height"] ?? -1, 0.3, accuracy: 0.000001)
  }

  func testTokenSpanCapsFallBackToParentOnlyDeterministically() {
    let tooMany = (0...alyteVisionMaxTokenSpansPerObservation).map { index in
      AlyteVisionTokenCandidate(
        text: "token\(index)",
        boundingBox: CGRect(x: 0.01, y: 0.01, width: 0.01, height: 0.01)
      )
    }
    XCTAssertNil(
      alyteExactTokenSpans(
        parentObservationId: "too-many",
        text: tooMany.map(\.text).joined(separator: " "),
        candidates: tooMany
      )
    )

    let largeText = String(repeating: "x", count: 15_000)
    let observation = alyteExactTokenSpans(
      parentObservationId: "large",
      text: largeText,
      candidates: [AlyteVisionTokenCandidate(text: largeText, boundingBox: CGRect(x: 0, y: 0, width: 1, height: 1))]
    )
    XCTAssertNil(observation)

    let pageSpan: [[String: Any]] = [[
      "id": "page-span",
      "parentObservationId": "parent",
      "start": 0,
      "end": 15_000,
      "text": largeText,
      "boundingBox": ["x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0],
    ]]
    let page = (0..<24).map { index -> [String: Any] in
      ["id": "parent-\(index)", "text": "source", "spans": pageSpan]
    }
    let capped = alyteApplyPageTokenSpanCap(page)
    XCTAssertNotNil(capped.first?["spans"])
    XCTAssertNil(capped.last?["spans"])
    XCTAssertEqual(capped.last?["id"] as? String, "parent-23")
    XCTAssertEqual(capped.last?["text"] as? String, "source")
  }

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
