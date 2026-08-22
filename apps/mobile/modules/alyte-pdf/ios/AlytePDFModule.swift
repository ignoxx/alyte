import ExpoModulesCore
import Foundation
import PDFKit
import UIKit

typealias AlytePDFPreviewResult = [String]

public final class AlytePDFModule: Module {
  private var sessions: [String: PDFDocument] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("AlytePDF")

    AsyncFunction("inspect") { (path: String) throws -> [String: Any] in
      try Self.inspection(for: PDFDocument(url: URL(fileURLWithPath: Self.filePath(from: path))))
    }

    AsyncFunction("unlock") { (path: String, password: String) throws -> [String: Any] in
      let documentURL = URL(fileURLWithPath: Self.filePath(from: path))
      guard let document = PDFDocument(url: documentURL) else {
        throw Self.error("The selected file is not a readable PDF", code: 10)
      }
      if document.isLocked && !document.unlock(withPassword: password) {
        throw Self.error("Wrong password for the selected PDF", code: 11)
      }
      let sessionID = UUID().uuidString
      self.lock.lock()
      self.sessions[sessionID] = document
      self.lock.unlock()
      var result = try Self.inspection(for: document)
      result["sessionId"] = sessionID
      return result
    }

    AsyncFunction("close") { (sessionID: String) in
      self.lock.lock()
      self.sessions.removeValue(forKey: sessionID)
      self.lock.unlock()
    }

    AsyncFunction("renderPreview") { (path: String) throws -> AlytePDFPreviewResult in
      let documentURL = URL(fileURLWithPath: Self.filePath(from: path))
      guard let document = PDFDocument(url: documentURL) else {
        throw Self.error("The selected file is not a readable PDF", code: 10)
      }
      return try Self.preview(for: document)
    }

    AsyncFunction("renderPreviewSession") { (sessionID: String) throws -> AlytePDFPreviewResult in
      self.lock.lock()
      let document = self.sessions[sessionID]
      self.lock.unlock()
      guard let document else {
        throw Self.error("The PDF preview session is no longer available", code: 12)
      }
      return try Self.preview(for: document)
    }
  }

  private static func preview(for document: PDFDocument) throws -> AlytePDFPreviewResult {
    guard !document.isLocked, document.pageCount > 0 else {
      throw error("The PDF is locked or has no readable pages", code: 13)
    }
    return try (0..<document.pageCount).map { index in
      guard let page = document.page(at: index) else {
        throw error("A PDF page could not be read", code: 14)
      }
      let thumbnail = page.thumbnail(of: CGSize(width: 1600, height: 2200), for: .mediaBox)
      guard let data = thumbnail.pngData() else {
        throw error("A PDF page could not be rendered", code: 14)
      }
      return "data:image/png;base64,\(data.base64EncodedString())"
    }
  }

  private static func inspection(for document: PDFDocument?) throws -> [String: Any] {
    guard let document else {
      throw error("The selected file is not a readable PDF", code: 10)
    }
    let locked = document.isLocked
    let pages: [[String: Any]] = locked ? [] : (0..<document.pageCount).compactMap { index in
      guard let page = document.page(at: index) else { return nil }
      let bounds = page.bounds(for: .mediaBox)
      return [
        "pageIndex": index,
        "width": Double(bounds.width),
        "height": Double(bounds.height),
        "hasTextLayer": page.string != nil,
      ]
    }
    var metadata: [String: String] = [:]
    if let attributes = document.documentAttributes {
      for (key, value) in attributes {
        guard let key = key as? String, let value = value as? String else { continue }
        metadata[key] = value
      }
    }
    return [
      "encrypted": document.isEncrypted,
      "locked": locked,
      "pageCount": document.pageCount,
      "metadata": metadata,
      "pages": pages,
    ]
  }

  private static func error(_ message: String, code: Int) -> NSError {
    NSError(domain: "AlytePDF", code: code, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private static func filePath(from value: String) -> String {
    if value.hasPrefix("file://"), let url = URL(string: value) { return url.path }
    return value
  }
}
