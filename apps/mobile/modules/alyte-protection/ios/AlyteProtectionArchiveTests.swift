import CryptoKit
import XCTest
import ZIPFoundation
@testable import AlyteProtection

final class AlyteProtectionArchiveTests: XCTestCase {
  func testSyntheticZipRoundTripsExactAllowlistedEntries() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let adapter = AlyteProtectionArchive()
    let expected = try fixture.files.map { file -> AlyteZipExpectedEntry in
      let policy = AlyteProtectionFilePolicy()
      return AlyteZipExpectedEntry(
        path: file.relative,
        bytes: Int64(try FileManager.default.attributesOfItem(atPath: file.url.path)[.size] as! NSNumber),
        sha256: try policy.hashFile(at: file.url)
      )
    }
    let result = try adapter.create(
      operationId: "export-test",
      stagingURL: fixture.staging,
      partialURL: fixture.partial,
      expected: expected
    )
    XCTAssertEqual(result.phase, "verified")
    XCTAssertEqual(result.entryCount, expected.count)
    let archive = try Archive(url: fixture.partial, accessMode: .read)
    XCTAssertEqual(Set(archive.map(\.path)), Set(expected.map(\.path)))
    let promoted = try adapter.promote(
      operationId: "export-test",
      partialURL: fixture.partial,
      archiveURL: fixture.final
    )
    XCTAssertEqual(promoted.phase, "promoted")
    XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.final.path))
  }

  func testRejectsSymlinkAndRemovesPartialOutput() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let linked = fixture.staging.appendingPathComponent("linked.txt")
    try FileManager.default.createSymbolicLink(
      at: linked,
      withDestinationURL: fixture.files[0].url
    )
    XCTAssertThrowsError(
      try AlyteProtectionArchive().create(
        operationId: "export-symlink",
        stagingURL: fixture.staging,
        partialURL: fixture.partial,
        expected: fixture.files.map { file in
          AlyteZipExpectedEntry(path: file.relative, bytes: 1, sha256: String(repeating: "0", count: 64))
        }
      )
    ) { error in
      XCTAssertEqual((error as? AlyteProtectionError)?.failureCategory, .archiveSymlink)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.partial.path))
  }

  func testCancelDeletesPartialOutputAndReturnsSanitizedResult() throws {
    let fixture = try makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    FileManager.default.createFile(atPath: fixture.partial.path, contents: Data("partial".utf8))
    let result = try AlyteProtectionArchive().cancel(
      operationId: "export-cancel",
      partialURL: fixture.partial
    )
    XCTAssertEqual(result.phase, "cancelled")
    XCTAssertEqual(result.entryCount, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.partial.path))
  }

  private func makeFixture() throws -> (
    directory: URL,
    staging: URL,
    partial: URL,
    final: URL,
    files: [(relative: String, url: URL)]
  ) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-zip-\(UUID().uuidString)", isDirectory: true)
    let exports = directory
      .appendingPathComponent("alyte-protected", isDirectory: true)
      .appendingPathComponent("exports", isDirectory: true)
    try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
    let staging = exports.appendingPathComponent("staging.partial", isDirectory: true)
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    let dataDirectory = staging.appendingPathComponent("data", isDirectory: true)
    try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
    let first = dataDirectory.appendingPathComponent("one.txt")
    let second = dataDirectory.appendingPathComponent("two.txt")
    try Data("synthetic-one".utf8).write(to: first)
    try Data("synthetic-two".utf8).write(to: second)
    return (
      directory,
      staging,
      exports.appendingPathComponent("export.zip.partial"),
      exports.appendingPathComponent("export.zip"),
      [("data/one.txt", first), ("data/two.txt", second)]
    )
  }
}
