import Foundation
import CryptoKit
import PDFKit

// macOS evaluation-only entry point. The extraction implementation remains the same PDFKit
// text-layer adapter shipped by Alyte; this file only supplies a command-line boundary so the
// adapter can be exercised without Expo or an iPhone build.
struct ReaderArguments {
  let input: String
  let output: String
}

func argument(_ name: String, in args: [String]) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func sha256(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

@main
struct AlyteMacPDFKitReader {
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let input = argument("--input", in: args), let output = argument("--output", in: args),
      let runtimeVersion = argument("--runtime-version", in: args), !runtimeVersion.isEmpty
    else {
      FileHandle.standardError.write(Data("reader-arguments-invalid\n".utf8))
      exit(2)
    }

    let inputURL = URL(fileURLWithPath: input)
    guard let reportData = try? Data(contentsOf: inputURL) else {
      FileHandle.standardError.write(Data("reader-document-unavailable\n".utf8))
      exit(3)
    }
    guard let document = PDFDocument(data: reportData), !document.isLocked, document.pageCount > 0
    else {
      FileHandle.standardError.write(Data("reader-document-unavailable\n".utf8))
      exit(3)
    }

    var pages: [[String: Any?]] = []
    pages.reserveCapacity(document.pageCount)
    for pageIndex in 0..<document.pageCount {
      guard let page = document.page(at: pageIndex) else {
        FileHandle.standardError.write(Data("reader-page-unavailable\n".utf8))
        exit(3)
      }
      let bounds = page.bounds(for: .mediaBox)
      pages.append([
        "pageIndex": pageIndex,
        "width": Double(bounds.width),
        "height": Double(bounds.height),
        "result": alytePDFTextLayerPage(document: document, pageIndex: pageIndex),
      ])
    }

    let envelope: [String: Any] = [
      "readerVersion": "alyte.mac.pdfkit-reader.v1",
      "reportSha256": sha256(reportData),
      "runtimeVersion": runtimeVersion,
      "pageCount": document.pageCount,
      "pages": pages,
    ]
    guard JSONSerialization.isValidJSONObject(envelope),
      let data = try? JSONSerialization.data(withJSONObject: envelope, options: [])
    else {
      FileHandle.standardError.write(Data("reader-output-invalid\n".utf8))
      exit(4)
    }

    do {
      try data.write(to: URL(fileURLWithPath: output), options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output)
    } catch {
      FileHandle.standardError.write(Data("reader-output-write-failed\n".utf8))
      exit(5)
    }

    let usable = pages.reduce(into: 0) { count, page in
      if page["result"] is [String: Any] { count += 1 }
    }
    FileHandle.standardOutput.write(Data("pages=\(document.pageCount) trusted=\(usable)\n".utf8))
  }
}
