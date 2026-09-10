import AppKit
import CryptoKit
import Foundation
import PDFKit
import Vision

// Evaluation-only macOS Vision fallback. The observation shaping is shared with Alyte's iOS
// adapter; this entry point supplies only PDFKit rendering and a file-output boundary.

func visionArgument(_ name: String, in args: [String]) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func visionSHA256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func visionImage(for page: PDFPage) -> CGImage? {
  let bounds = page.bounds(for: .mediaBox)
  guard bounds.width > 0, bounds.height > 0 else { return nil }
  let scale: CGFloat = 2
  let image = page.thumbnail(
    of: CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale)),
    for: .mediaBox
  )
  var proposedRect = NSRect(origin: .zero, size: image.size)
  return image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil)
}

func visionPageResult(_ page: PDFPage, pageIndex: Int) async throws -> [String: Any] {
  guard let image = visionImage(for: page) else { throw NSError(domain: "alyte.vision", code: 1) }
  var request = RecognizeDocumentsRequest()
  request.textRecognitionOptions.automaticallyDetectLanguage = true
  request.textRecognitionOptions.useLanguageCorrection = true
  request.textRecognitionOptions.maximumCandidateCount = 5
  let preferred = alyteVisionPreferredRecognitionLanguageIdentifiers.map {
    Locale.Language(identifier: $0)
  }
  request.textRecognitionOptions.recognitionLanguages = preferred.filter {
    request.supportedRecognitionLanguages.contains($0)
  }
  let documents = try await request.perform(on: image, orientation: .up)
  var observations: [[String: Any]] = []
  for (documentIndex, document) in documents.enumerated() {
    for (tableIndex, table) in document.document.tables.enumerated() {
      var emittedTableCellIDs = Set<String>()
      for row in table.rows {
        for cell in row {
          guard let coordinates = alyteVisionTableCellCoordinates(
            rowRange: cell.rowRange, columnRange: cell.columnRange
          ) else { continue }
          let cellID = "document-\(pageIndex)-\(documentIndex)-table-\(tableIndex)-\(coordinates.identitySuffix)"
          guard emittedTableCellIDs.insert(cellID).inserted else { continue }
          let text = cell.content.text.transcript
          guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
          observations.append(contentsOf: alyteDocumentObservations(
            id: cellID,
            text: text,
            box: cell.content.boundingRegion.boundingBox.cgRect,
            pageIndex: pageIndex,
            orientation: 0,
            structure: [
              "kind": "table-cell",
              "tableId": "table-\(documentIndex)-\(tableIndex)",
              "rowIndex": coordinates.rowIndex,
              "columnIndex": coordinates.columnIndex,
            ],
            lines: cell.content.text.lines,
            words: cell.content.text.words
          ))
        }
      }
    }
    let tableBoxes = document.document.tables.map { $0.boundingRegion.boundingBox.cgRect }
    for (lineIndex, line) in document.document.text.lines.enumerated() {
      let text = line.transcript
      guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
      guard !tableBoxes.contains(where: { $0.intersects(line.boundingBox.cgRect) }) else { continue }
      observations.append(contentsOf: alyteDocumentObservations(
        id: "document-\(pageIndex)-\(documentIndex)-line-\(lineIndex)",
        text: text,
        box: line.boundingBox.cgRect,
        pageIndex: pageIndex,
        orientation: 0,
        structure: ["kind": "text", "tableId": NSNull(), "rowIndex": NSNull(), "columnIndex": NSNull()],
        lines: [line],
        words: alyteWords(in: line.boundingBox.cgRect, from: document.document.text.words)
      ))
    }
  }
  return [
    "contractVersion": "alyte.vision.document.v4",
    "pageIndex": pageIndex,
    "orientation": 0,
    "observations": alyteApplyPageTokenSpanCap(observations),
  ]
}

@main
struct AlyteMacVisionReader {
  static func main() async {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let input = visionArgument("--input", in: args),
      let output = visionArgument("--output", in: args),
      let runtimeVersion = visionArgument("--runtime-version", in: args), !runtimeVersion.isEmpty
    else {
      FileHandle.standardError.write(Data("vision-arguments-invalid\n".utf8))
      exit(2)
    }
    let inputURL = URL(fileURLWithPath: input)
    guard let reportData = try? Data(contentsOf: inputURL),
      let document = PDFDocument(data: reportData), !document.isLocked,
      document.pageCount > 0
    else {
      FileHandle.standardError.write(Data("vision-document-unavailable\n".utf8))
      exit(3)
    }

    var pages: [[String: Any?]] = []
    pages.reserveCapacity(document.pageCount)
    var usable = 0
    for pageIndex in 0..<document.pageCount {
      guard let page = document.page(at: pageIndex) else {
        pages.append(["pageIndex": pageIndex, "result": nil])
        continue
      }
      let bounds = page.bounds(for: .mediaBox)
      do {
        let result = try await visionPageResult(page, pageIndex: pageIndex)
        if let count = result["observations"] as? [[String: Any]], !count.isEmpty { usable += 1 }
        pages.append([
          "pageIndex": pageIndex,
          "width": Double(bounds.width),
          "height": Double(bounds.height),
          "result": result,
        ])
      } catch {
        pages.append([
          "pageIndex": pageIndex,
          "width": Double(bounds.width),
          "height": Double(bounds.height),
          "result": nil,
        ])
      }
    }
    let envelope: [String: Any] = [
      "readerVersion": "alyte.mac.vision-reader.v1",
      "reportSha256": visionSHA256(reportData),
      "runtimeVersion": runtimeVersion,
      "pageCount": document.pageCount,
      "pages": pages,
    ]
    guard JSONSerialization.isValidJSONObject(envelope),
      let data = try? JSONSerialization.data(withJSONObject: envelope, options: [])
    else {
      FileHandle.standardError.write(Data("vision-output-invalid\n".utf8))
      exit(4)
    }
    do {
      try data.write(to: URL(fileURLWithPath: output), options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
    } catch {
      FileHandle.standardError.write(Data("vision-output-write-failed\n".utf8))
      exit(5)
    }
    FileHandle.standardOutput.write(Data("pages=\(document.pageCount) recognized=\(usable)\n".utf8))
  }
}

