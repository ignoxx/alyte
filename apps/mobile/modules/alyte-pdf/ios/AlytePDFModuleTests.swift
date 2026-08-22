import Foundation
import PDFKit
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
}
