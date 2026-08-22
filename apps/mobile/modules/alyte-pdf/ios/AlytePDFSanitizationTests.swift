import Foundation
import PDFKit
import UIKit
import XCTest

/// Production-path XCTest specs. The CI host has no iOS SDK/runtime, so these compile as the
/// module's test target and execute in the simulator/device lane when an iOS runtime is present.
final class AlytePDFSanitizationTests: XCTestCase {
  func testImageOnlyRendererRemovesSourceStructureAndReloads() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let output = directory.appendingPathComponent("derivative.pdf")
    let recipe: [String: Any] = ["pages": [["pageIndex": 0, "selected": true, "crop": NSNull(), "rotation": 90, "redactions": [["rect": ["x": 0.2, "y": 0.2, "width": 0.25, "height": 0.1]]]]]]
    _ = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe)
    let verification = try AlytePDFSanitizationTestSupport.verify(url: output, forbiddenStrings: ["SYNTHETIC-SOURCE-METADATA", "SYNTHETIC-HIDDEN-TEXT"])
    XCTAssertEqual(verification["verified"] as? Bool, true)
    XCTAssertEqual(verification["selectableText"] as? Bool, false)
    XCTAssertEqual(verification["annotations"] as? Bool, false)
    XCTAssertEqual(verification["metadata"] as? Bool, false)
    XCTAssertEqual(verification["reloadChecked"] as? Bool, true)
  }

  func testAdversarialForbiddenContentGatesVerification() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let output = directory.appendingPathComponent("derivative.pdf")
    let recipe: [String: Any] = ["pages": [["pageIndex": 0, "selected": true, "crop": NSNull(), "rotation": 0, "redactions": []]]]
    _ = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe)
    let verification = try AlytePDFSanitizationTestSupport.verify(url: output, forbiddenStrings: ["SYNTHETIC-HIDDEN-TEXT"])
    XCTAssertEqual(verification["verified"] as? Bool, true)
    XCTAssertEqual(verification["reloadChecked"] as? Bool, true)
  }

  private func syntheticSourceDocument(in directory: URL) throws -> PDFDocument {
    let sourceURL = directory.appendingPathComponent("source.pdf")
    UIGraphicsBeginPDFContextToFile(sourceURL.path, CGRect(x: 0, y: 0, width: 600, height: 800), nil)
    UIGraphicsBeginPDFPage()
    ("SYNTHETIC-VISIBLE-TEXT" as NSString).draw(at: CGPoint(x: 40, y: 60), withAttributes: [.font: UIFont.systemFont(ofSize: 18)])
    let hidden = NSMutableParagraphStyle(); hidden.alignment = .left
    ("SYNTHETIC-HIDDEN-TEXT" as NSString).draw(at: CGPoint(x: 40, y: 120), withAttributes: [.font: UIFont.systemFont(ofSize: 14), .foregroundColor: UIColor.clear, .paragraphStyle: hidden])
    UIGraphicsEndPDFContext()
    let source = try XCTUnwrap(PDFDocument(url: sourceURL))
    source.documentAttributes = [.titleAttribute: "SYNTHETIC-SOURCE-METADATA"]
    source.page(at: 0)?.addAnnotation(PDFAnnotation(bounds: CGRect(x: 20, y: 20, width: 80, height: 24), forType: .freeText, withProperties: nil))
    return source
  }
}
