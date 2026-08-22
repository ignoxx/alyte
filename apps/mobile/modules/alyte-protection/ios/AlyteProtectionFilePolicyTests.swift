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

  func testMissingSidecarsAreToleratedAndReportedAfterWritesAreAllowed() throws {
    let fixture = try makeFixture(includeSidecars: false)
    defer { try? FileManager.default.removeItem(at: fixture.directory) }

    let report = try AlyteProtectionFilePolicy().protectDatabaseFiles(
      at: fixture.database,
      requireSidecars: true
    )

    XCTAssertEqual(report.protectedPaths, [fixture.database.path])
    XCTAssertEqual(Set(report.missingSidecarPaths), Set(fixture.paths.dropFirst().map(\.path)))
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

  func testDevelopmentSimulatorPathStillRequiresBackupExclusion() throws {
    let fixture = try makeFixture(includeSidecars: false)
    defer { try? FileManager.default.removeItem(at: fixture.directory) }

    let report = try AlyteProtectionFilePolicy(
      environment: AlyteProtectionEnvironment(
        isSimulator: true,
        allowsDevelopmentSimulatorFallback: true
      )
    ).protectDatabaseFiles(at: fixture.database, requireSidecars: true)

    XCTAssertEqual(report.protectedPaths, [fixture.database.path])
    XCTAssertEqual(
      try fixture.database.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
      true
    )
  }

  func testProtectionFailuresExposeOnlySanitizedCategories() {
    XCTAssertEqual(
      AlyteProtectionError.primaryDatabaseMissing.failureCategory,
      .primaryDatabaseMissing
    )
    XCTAssertEqual(
      AlyteProtectionError.dataProtectionVerificationFailed.failureCategory,
      .dataProtectionVerification
    )
    XCTAssertEqual(
      AlyteProtectionError.backupExclusionVerificationFailed.failureCategory,
      .backupExclusionVerification
    )
  }

  func testProtectPathVerifiesOriginalReportProtectionAndHashIsContentBound() throws {
    let fixture = try makeFixture(includeSidecars: false)
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let reportURL = fixture.directory.appendingPathComponent("original-report.pdf")
    try Data("synthetic-original-report".utf8).write(to: reportURL)

    let policy = AlyteProtectionFilePolicy()
    let report = try policy.protectPath(at: reportURL)
    let firstHash = try policy.hashFile(at: reportURL)
    try Data("synthetic-original-report-changed".utf8).write(to: reportURL)
    let secondHash = try policy.hashFile(at: reportURL)

    XCTAssertEqual(report.protectedPaths, [reportURL.path])
    XCTAssertEqual(
      try reportURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
      true
    )
    XCTAssertNotEqual(firstHash, secondHash)
    XCTAssertEqual(firstHash.count, 64)
    XCTAssertEqual(secondHash.count, 64)
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
