import Foundation
import PDFKit
import UIKit
import Vision
import XCTest

/// Production-path XCTest specs. The CI host has no iOS SDK/runtime, so these compile as the
/// module's test target and execute in the simulator/device lane when an iOS runtime is present.
final class AlytePDFSanitizationTests: XCTestCase {
  func testSanitizedRasterRemainsReadableToLocalOCRInDarkAppearance() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let output = directory.appendingPathComponent("ocr-readable.pdf")
    let recipe: [String: Any] = ["pages": [["pageIndex": 0, "selected": true, "crop": NSNull(), "rotation": 0, "redactions": []]]]

    var recognized: [String] = []
    try UITraitCollection(userInterfaceStyle: .dark).performAsCurrent {
      _ = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe)
      let derivative = try XCTUnwrap(PDFDocument(url: output))
      let page = try XCTUnwrap(derivative.page(at: 0))
      let bounds = page.bounds(for: .mediaBox)
      let image = page.thumbnail(of: CGSize(width: bounds.width * 2, height: bounds.height * 2), for: .mediaBox)
      let cgImage = try XCTUnwrap(image.cgImage)
      let corner = try XCTUnwrap(rgbaPixel(in: cgImage, x: 4, y: 4))
      XCTAssertGreaterThan(corner.red, 240)
      XCTAssertGreaterThan(corner.green, 240)
      XCTAssertGreaterThan(corner.blue, 240)
      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      try VNImageRequestHandler(cgImage: cgImage, orientation: .up).perform([request])
      recognized = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    XCTAssertTrue(recognized.contains { $0.contains("SYNTHETIC-VISIBLE-TEXT") })
    XCTAssertTrue(recognized.contains { $0.contains("LDL") && $0.contains("118") })
  }

  func testImageOnlyRendererRemovesSourceStructureAndReloads() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let sourceAnnotations = source.page(at: 0)?.annotations ?? []
    XCTAssertTrue(sourceAnnotations.contains { $0.type == "FileAttachment" })
    XCTAssertTrue(sourceAnnotations.contains { $0.type == "Square" })
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
    let firstBounds = try XCTUnwrap(derivative.page(at: 0)?.bounds(for: .mediaBox))
    let secondBounds = try XCTUnwrap(derivative.page(at: 1)?.bounds(for: .mediaBox))
    // Page 1 was selected first: its .8x.7 crop rotated 270° has a 1.17 aspect ratio. Page 0
    // follows it with a .9x.9 crop rotated 90° and has a 1.33 aspect ratio.
    XCTAssertEqual(firstBounds.width / firstBounds.height, 7.0 / 6.0, accuracy: 0.03)
    XCTAssertEqual(secondBounds.width / secondBounds.height, 4.0 / 3.0, accuracy: 0.03)
    XCTAssertGreaterThan(secondBounds.width / secondBounds.height, firstBounds.width / firstBounds.height)
    XCTAssertTrue(derivative.page(at: 0)?.annotations.isEmpty ?? false)
    XCTAssertTrue(derivative.page(at: 1)?.annotations.isEmpty ?? false)
    let sameRecipeOutput = directory.appendingPathComponent("derivative-scale-independent.pdf")
    _ = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: sameRecipeOutput, recipe: recipe)
    let sameRecipe = try XCTUnwrap(PDFDocument(url: sameRecipeOutput))
    let sameFirstBounds = try XCTUnwrap(sameRecipe.page(at: 0)?.bounds(for: .mediaBox))
    XCTAssertEqual(sameFirstBounds.width, firstBounds.width, accuracy: 0.01)
    XCTAssertEqual(sameFirstBounds.height, firstBounds.height, accuracy: 0.01)
    let verificationAfterReload = try AlytePDFSanitizationTestSupport.verify(url: output, forbiddenStrings: ["SYNTHETIC-SOURCE-METADATA", "SYNTHETIC-HIDDEN-TEXT"])
    XCTAssertEqual(verificationAfterReload["selectableText"] as? Bool, false)
    XCTAssertEqual(verificationAfterReload["annotations"] as? Bool, false)
    XCTAssertEqual(verificationAfterReload["attachments"] as? Bool, false)
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

  func testExpoBridgeFoundationContainersAndNumbersDecodeStrictly() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let output = directory.appendingPathComponent("bridge-derivative.pdf")

    // Expo can bridge JavaScript objects as NSDictionary/NSArray and all JSON numbers as NSNumber.
    // Keep both a selected and an excluded page so every recipe field crosses the native boundary.
    let redaction = NSDictionary(dictionary: [
      "rect": NSDictionary(dictionary: [
        "x": NSNumber(value: 0.35),
        "y": NSNumber(value: 0.4),
        "width": NSNumber(value: 0.3),
        "height": NSNumber(value: 0.08),
      ]),
    ])
    let selectedPage = NSDictionary(dictionary: [
      "pageIndex": NSNumber(value: 0),
      "selected": NSNumber(value: true),
      "crop": NSNull(),
      "rotation": NSNumber(value: 0),
      "redactions": NSArray(array: [redaction]),
    ])
    let excludedPage = NSDictionary(dictionary: [
      "pageIndex": NSNumber(value: 1),
      "selected": NSNumber(value: false),
      "crop": NSNull(),
      "rotation": NSNumber(value: 90),
      "redactions": NSArray(),
    ])
    let recipe: [String: Any] = [
      "schemaVersion": NSNumber(value: 1),
      "pages": NSArray(array: [selectedPage, excludedPage]),
    ]

    let rendered = try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe)
    XCTAssertEqual(rendered["pageCount"] as? Int, 1)
    let verification = try XCTUnwrap(rendered["verification"] as? [String: Any])
    XCTAssertEqual(verification["verified"] as? Bool, true)
    XCTAssertEqual(verification["sourceAwareChecked"] as? Bool, true)
    XCTAssertEqual(try XCTUnwrap(PDFDocument(url: output)).pageCount, 1)
  }

  func testExpoBridgeNumericFieldsRejectFractionalIntegers() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-sanitize-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = try syntheticSourceDocument(in: directory)
    let output = directory.appendingPathComponent("invalid-bridge-derivative.pdf")
    let recipe: [String: Any] = [
      "pages": NSArray(array: [NSDictionary(dictionary: [
        "pageIndex": NSNumber(value: 0.5),
        "selected": NSNumber(value: true),
        "crop": NSNull(),
        "rotation": NSNumber(value: 0),
        "redactions": NSArray(),
      ])]),
    ]

    XCTAssertThrowsError(try AlytePDFSanitizationTestSupport.render(document: source, destinationURL: output, recipe: recipe))
    XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
  }

  private func syntheticSourceDocument(in directory: URL) throws -> PDFDocument {
    let sourceURL = directory.appendingPathComponent("source.pdf")
    UIGraphicsBeginPDFContextToFile(sourceURL.path, CGRect(x: 0, y: 0, width: 600, height: 800), nil)
    UIGraphicsBeginPDFPage()
    ("SYNTHETIC-VISIBLE-TEXT" as NSString).draw(at: CGPoint(x: 40, y: 60), withAttributes: [.font: UIFont.systemFont(ofSize: 18)])
    ("LDL cholesterol 118 mg/dL" as NSString).draw(at: CGPoint(x: 40, y: 92), withAttributes: [.font: UIFont.systemFont(ofSize: 18)])
    let hidden = NSMutableParagraphStyle(); hidden.alignment = .left
    ("SYNTHETIC-HIDDEN-TEXT" as NSString).draw(at: CGPoint(x: 40, y: 120), withAttributes: [.font: UIFont.systemFont(ofSize: 14), .foregroundColor: UIColor.clear, .paragraphStyle: hidden])
    UIGraphicsEndPDFContext()
    let source = try XCTUnwrap(PDFDocument(url: sourceURL))
    if let firstPage = source.page(at: 0), let secondPage = PDFPage(image: UIImage(color: .white, size: CGSize(width: 600, height: 800))) {
      secondPage.addAnnotation(PDFAnnotation(bounds: CGRect(x: 30, y: 30, width: 70, height: 20), forType: .freeText, withProperties: nil))
      source.insert(secondPage, at: 1)
      _ = firstPage
    }
    source.documentAttributes = [PDFDocumentAttribute.titleAttribute: "SYNTHETIC-SOURCE-METADATA"]
    let firstPage = try XCTUnwrap(source.page(at: 0))
    firstPage.addAnnotation(PDFAnnotation(bounds: CGRect(x: 20, y: 20, width: 80, height: 24), forType: .freeText, withProperties: nil))
    firstPage.addAnnotation(PDFAnnotation(bounds: CGRect(x: 120, y: 20, width: 80, height: 24), forType: .square, withProperties: nil))
    let fileSpec: [String: Any] = [
      "Type": "Filespec",
      "F": "synthetic-attachment.txt",
      "EF": ["F": Data("synthetic attachment".utf8)],
    ]
    firstPage.addAnnotation(PDFAnnotation(
      bounds: CGRect(x: 220, y: 20, width: 80, height: 24),
      forType: PDFAnnotationSubtype(rawValue: "FileAttachment"),
      withProperties: ["FS": fileSpec]
    ))
    return source
  }
}

private func rgbaPixel(in image: CGImage, x: Int, y: Int) -> (red: UInt8, green: UInt8, blue: UInt8)? {
  guard x >= 0, y >= 0, x < image.width, y < image.height else { return nil }
  var pixel = [UInt8](repeating: 0, count: 4)
  guard let context = CGContext(
    data: &pixel,
    width: 1,
    height: 1,
    bitsPerComponent: 8,
    bytesPerRow: 4,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  context.translateBy(x: CGFloat(-x), y: CGFloat(y - image.height + 1))
  context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
  return (pixel[0], pixel[1], pixel[2])
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
