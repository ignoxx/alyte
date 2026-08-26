import Foundation
import PDFKit
import UIKit
import XCTest

final class AlytePDFModuleTests: XCTestCase {
  func testPreviewBridgeContractIsAnArrayOfPageUris() {
    let pages: AlytePDFPreviewResult = [
      "data:image/png;base64,synthetic-page-1",
      "data:image/png;base64,synthetic-page-2",
    ]

    XCTAssertEqual(pages.count, 2)
    XCTAssertTrue(pages.allSatisfy { $0.hasPrefix("data:image/png;base64,") })
  }

  func testSyntheticPasswordPdfRejectsWrongPasswordAndAcceptsCorrectPassword() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-pdf-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let source = PDFDocument()
    source.insert(PDFPage(), at: 0)
    let url = directory.appendingPathComponent("password.pdf")
    let options: [PDFDocumentWriteOption: Any] = [
      .ownerPasswordOption: "synthetic-owner",
      .userPasswordOption: "synthetic-user",
    ]
    XCTAssertTrue(source.write(to: url, withOptions: options))

    let locked = try XCTUnwrap(PDFDocument(url: url))
    XCTAssertTrue(locked.isEncrypted)
    XCTAssertTrue(locked.isLocked)
    XCTAssertFalse(locked.unlock(withPassword: "wrong-password"))
    XCTAssertTrue(locked.isLocked)
    XCTAssertTrue(locked.unlock(withPassword: "synthetic-user"))
    XCTAssertFalse(locked.isLocked)
    XCTAssertNotNil(locked.page(at: 0))
  }

  func testUnreadablePdfIsNotReportedAsAValidPreviewSource() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-pdf-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let url = directory.appendingPathComponent("not-a-pdf.pdf")
    try Data("synthetic-not-pdf".utf8).write(to: url)

    XCTAssertNil(PDFDocument(url: url))
  }

  func testViewerSessionRetainsMixedPageGeometryUntilExplicitClose() throws {
    let document = PDFDocument()
    for size in [
      CGSize(width: 612, height: 792),
      CGSize(width: 792, height: 612),
      CGSize(width: 612, height: 792),
      CGSize(width: 792, height: 612),
    ] {
      let image = UIGraphicsImageRenderer(size: size).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: size))
      }
      document.insert(try XCTUnwrap(PDFPage(image: image)), at: document.pageCount)
    }

    let sessionId = AlytePDFSessionStore.shared.insert(document)
    let session = try XCTUnwrap(AlytePDFSessionStore.shared.document(for: sessionId))
    XCTAssertEqual(session.pageCount, 4)
    XCTAssertEqual(session.page(at: 0)?.bounds(for: .mediaBox).size, CGSize(width: 612, height: 792))
    XCTAssertEqual(session.page(at: 1)?.bounds(for: .mediaBox).size, CGSize(width: 792, height: 612))

    AlytePDFSessionStore.shared.remove(sessionId)
    XCTAssertNil(AlytePDFSessionStore.shared.document(for: sessionId))
  }

  func testViewerSummaryDoesNotExposePageInspectionForLargeDocuments() throws {
    let document = PDFDocument()
    for index in 0..<4096 {
      document.insert(PDFPage(), at: index)
    }

    let result = try viewerSummary(document, sessionId: "synthetic-viewer")

    XCTAssertEqual(result["locked"] as? Bool, false)
    XCTAssertEqual(result["pageCount"] as? Int, 4096)
    XCTAssertEqual(result["sessionId"] as? String, "synthetic-viewer")
    XCTAssertNil(result["metadata"])
    XCTAssertNil(result["pages"])
  }

  func testAbandonedViewerSessionsExpireEvictAndReleaseIdempotently() {
    var clock = Date(timeIntervalSince1970: 1_000)
    let store = AlytePDFSessionStore(maxEntries: 2, ttl: 60, now: { clock })
    let first = store.insert(PDFDocument())
    let second = store.insert(PDFDocument())
    _ = store.document(for: first)
    let third = store.insert(PDFDocument())

    XCTAssertNil(store.document(for: second))
    XCTAssertNotNil(store.document(for: first))
    XCTAssertNotNil(store.document(for: third))

    clock.addTimeInterval(61)
    XCTAssertNil(store.document(for: first))
    XCTAssertNil(store.document(for: third))
    store.remove(first)
    store.remove(first)
    store.removeAll()
  }
}
