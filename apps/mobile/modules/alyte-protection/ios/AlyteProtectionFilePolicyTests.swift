import XCTest

final class AlyteProtectionFilePolicyTests: XCTestCase {
  func testProtectsDatabaseAndSQLiteSidecarsWithDataProtectionAndBackupExclusion() throws {
    let fixture = try makeFixture(includeSidecars: true)
    defer { try? FileManager.default.removeItem(at: fixture.directory) }

    let report = try AlyteProtectionFilePolicy().protectDatabaseFiles(
      at: fixture.database,
      requireSidecars: true
    )

    XCTAssertEqual(Set(report.protectedPaths), Set(fixture.paths.map(\.path)))
    XCTAssertTrue(report.missingSidecarPaths.isEmpty)
    for path in fixture.paths {
      let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
      XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .complete)
      XCTAssertEqual(
        try path.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
        true
      )
    }
  }

  func testMissingSidecarIsAProtectionFailureOnceWritesAreAllowed() throws {
    let fixture = try makeFixture(includeSidecars: false)
    defer { try? FileManager.default.removeItem(at: fixture.directory) }

    XCTAssertThrowsError(
      try AlyteProtectionFilePolicy().protectDatabaseFiles(
        at: fixture.database,
        requireSidecars: true
      )
    ) { error in
      guard case AlyteProtectionError.sidecarsMissing = error else {
        return XCTFail("Expected missing-sidecar protection failure, got \(error)")
      }
    }
  }

  func testFirstOpenMayProtectPrimaryBeforeSQLiteCreatesSidecars() throws {
    let fixture = try makeFixture(includeSidecars: false)
    defer { try? FileManager.default.removeItem(at: fixture.directory) }

    let report = try AlyteProtectionFilePolicy().protectDatabaseFiles(
      at: fixture.database,
      requireSidecars: false
    )
    XCTAssertEqual(report.protectedPaths, [fixture.database.path])
    XCTAssertEqual(Set(report.missingSidecarPaths), Set(fixture.paths.dropFirst().map(\.path)))
  }

  private func makeFixture(includeSidecars: Bool) throws -> (directory: URL, database: URL, paths: [URL]) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-protection-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let database = directory.appendingPathComponent("alyte.sqlite")
    let paths = [database, directory.appendingPathComponent("alyte.sqlite-wal"), directory.appendingPathComponent("alyte.sqlite-shm")]
    FileManager.default.createFile(atPath: database.path, contents: Data())
    if includeSidecars {
      for path in paths.dropFirst() {
        FileManager.default.createFile(atPath: path.path, contents: Data())
      }
    }
    return (directory, database, paths)
  }
}
