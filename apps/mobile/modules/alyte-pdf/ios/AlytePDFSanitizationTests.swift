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
    let recipe: [String: Any] = ["pages": [
      ["pageIndex": 1, "selected": true, "crop": ["x": 0.1, "y": 0.1, "width": 0.8, "height": 0.7], "rotation": 270, "redactions": [["rect": ["x": 0.2, "y": 0.2, "width": 0.25, "height": 0.1]]]],
      ["pageIndex": 0, "selected": true, "crop": ["x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9], "rotation": 90, "redactions": []],
    ]]
    let rendered = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe)
    let verification = try XCTUnwrap(rendered["verification"] as? [String: Any])
    XCTAssertEqual(verification["sourceAwareChecked"] as? Bool, true)
    XCTAssertEqual(verification["sourceContentRemoved"] as? Bool, true)
    let derivative = try XCTUnwrap(PDFDocument(url: output))
    XCTAssertEqual(derivative.pageCount, 2)
    XCTAssertGreaterThan(derivative.page(at: 0)?.bounds(for: .mediaBox).width ?? 0, 0)
    XCTAssertGreaterThan(derivative.page(at: 1)?.bounds(for: .mediaBox).width ?? 0, 0)
    let verificationAfterReload = try AlytePDFSanitizationTestSupport.verify(url: output, forbiddenStrings: ["SYNTHETIC-SOURCE-METADATA", "SYNTHETIC-HIDDEN-TEXT"])
    XCTAssertEqual(verificationAfterReload["selectableText"] as? Bool, false)
    XCTAssertEqual(verificationAfterReload["annotations"] as? Bool, false)
    XCTAssertEqual(verificationAfterReload["metadata"] as? Bool, false)
    XCTAssertEqual(verificationAfterReload["reloadChecked"] as? Bool, true)
  }

  func testAdversarialForbiddenContentGatesVerification() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let output = directory.appendingPathComponent("derivative.pdf")
    let recipe: [String: Any] = ["pages": [["pageIndex": 0, "selected": true, "crop": ["x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6], "rotation": 180, "redactions": []]]]
    let rendered = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe)
    let verification = try XCTUnwrap(rendered["verification"] as? [String: Any])
    XCTAssertEqual(verification["sourceAwareChecked"] as? Bool, true)
    XCTAssertEqual(verification["sourceContentRemoved"] as? Bool, true)
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
    if let firstPage = source.page(at: 0), let secondPage = PDFPage(image: UIImage(color: .white, size: CGSize(width: 600, height: 800))) {
      secondPage.addAnnotation(PDFAnnotation(bounds: CGRect(x: 30, y: 30, width: 70, height: 20), forType: .freeText, withProperties: nil))
      source.insert(secondPage, at: 1)
      _ = firstPage
    }
    source.documentAttributes = [.titleAttribute: "SYNTHETIC-SOURCE-METADATA"]
    source.page(at: 0)?.addAnnotation(PDFAnnotation(bounds: CGRect(x: 20, y: 20, width: 80, height: 24), forType: .freeText, withProperties: nil))
    return source
  }
}

private extension UIImage {
  convenience init(color: UIColor, size: CGSize) {
    UIGraphicsBeginImageContextWithOptions(size, true, 1)
    color.setFill(); UIRectFill(CGRect(origin: .zero, size: size))
    let image = UIGraphicsGetImageFromCurrentImageContext() ?? UIImage()
    UIGraphicsEndImageContext()
    self.init(cgImage: image.cgImage!)
  }
}
