import Foundation
import XCTest
@testable import AlyteLocalModelTestSupport

final class NativeModelHarnessTests: XCTestCase {
  private func makeHarness() throws -> (NativeModelHarness, URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-local-model-native-\(UUID().uuidString)")
    let harness = try NativeModelHarness(directory: root)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return (harness, root)
  }

  func testColdRelaunchDiscoversVerifiedReadyAndRejectsCorruptReady() throws {
    let (harness, _) = try makeHarness()
    _ = FileManager.default.createFile(atPath: harness.readyURL.path, contents: Data("valid".utf8))
    try harness.discover()
    XCTAssertEqual(harness.state, .ready)
    try Data("bad!!".utf8).write(to: harness.readyURL)
    try harness.discover()
    XCTAssertEqual(harness.state, .failed("checksumMismatch"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.readyURL.path))
  }

  func testCancellationPreservesPartialButNeverReady() throws {
    let (harness, _) = try makeHarness()
    try harness.begin()
    try Data("part".utf8).write(to: harness.partialURL)
    harness.cancel()
    XCTAssertEqual(harness.state, .notInstalled)
    XCTAssertTrue(FileManager.default.fileExists(atPath: harness.partialURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.readyURL.path))
  }

  func testCompleteInvalidPartialRestartsAndRangeFailuresAreDeterministic() throws {
    let (harness, _) = try makeHarness()
    _ = FileManager.default.createFile(atPath: harness.partialURL.path, contents: Data("bad!!".utf8))
    try harness.begin()
    XCTAssertEqual(harness.offset, 0)
    XCTAssertThrowsError(try harness.acceptResponse(status: 416, url: URL(string: "https://huggingface.co/file")!))
    XCTAssertEqual(harness.state, .failed("range-rejected"))
  }

  func testRedirectAllowlistAndIgnoredRangeAreFailClosed() throws {
    let (harness, _) = try makeHarness()
    try harness.begin()
    try Data("pa".utf8).write(to: harness.partialURL)
    harness.setResumeOffsetForTesting(2)
    XCTAssertThrowsError(try harness.acceptResponse(status: 302, url: URL(string: "https://evil.example/file")!))
    XCTAssertThrowsError(try harness.acceptResponse(status: 206, contentRangeStart: 3, url: URL(string: "https://cdn-lfs.huggingface.co/file")!))
  }

  func testSizeChecksumAndProtectionFailuresDoNotPromote() throws {
    let (harness, _) = try makeHarness()
    try harness.begin()
    try Data("bad!!".utf8).write(to: harness.partialURL)
    XCTAssertThrowsError(try harness.promote())
    try Data("valid".utf8).write(to: harness.partialURL)
    harness.protect = { _ in throw NativeModelHarnessError.storageProtection }
    XCTAssertThrowsError(try harness.promote())
    XCTAssertFalse(FileManager.default.fileExists(atPath: harness.readyURL.path))
  }

  func testAtomicReplacementRestoresPreviousReadyAfterFailure() throws {
    let (harness, root) = try makeHarness()
    _ = FileManager.default.createFile(atPath: harness.readyURL.path, contents: Data("valid".utf8))
    try harness.begin()
    try Data("valid".utf8).write(to: harness.partialURL)
    harness.failNextPromotion()
    XCTAssertThrowsError(try harness.promote())
    XCTAssertEqual(try Data(contentsOf: harness.readyURL), Data("valid".utf8))
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".model.previous").path))
  }

  func testDeletePreservesUnrelatedHealthPathAndPressureClosesRuntime() throws {
    let (harness, root) = try makeHarness()
    try Data("health".utf8).write(to: root.appendingPathComponent("health.sqlite"))
    _ = FileManager.default.createFile(atPath: harness.readyURL.path, contents: Data("valid".utf8))
    try harness.discover()
    try harness.load()
    let runtime = try XCTUnwrap(harness.runtime)
    harness.releaseForPressure()
    XCTAssertTrue(runtime.isClosed)
    try harness.deleteModel()
    XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("health.sqlite").path))
    XCTAssertEqual(harness.state, .notInstalled)
  }
}
