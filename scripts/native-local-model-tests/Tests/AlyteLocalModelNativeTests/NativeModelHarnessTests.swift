import Foundation
import XCTest
@testable import AlyteLocalModelProductionCore

private final class SyntheticRuntime: AlyteLocalModelRuntimeSession {
  private(set) var isClosed = false
  private(set) var cancellationRequested = false
  func generate(prompt: String, maxOutputTokens: Int, outputCapacity: Int) throws -> String {
    if cancellationRequested { throw AlyteLocalModelRuntimeError.cancelled }
    _ = prompt
    _ = maxOutputTokens
    _ = outputCapacity
    return "{\"schemaVersion\":\"alyte.semantic-mapper.v1\",\"proposals\":[]}"
  }
  func cancelInference() { cancellationRequested = true }
  func close() { isClosed = true }
}

final class NativeModelHarnessTests: XCTestCase {
  func testSwiftManifestDecodesExactlyFromAuthoritativeProductionSource() throws {
    var sourceURL = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { sourceURL.deleteLastPathComponent() }
    sourceURL.appendPathComponent("apps/mobile/modules/alyte-local-models/manifest/production.json")
    let source = try JSONSerialization.jsonObject(with: Data(contentsOf: sourceURL)) as! NSDictionary
    XCTAssertTrue(source.isEqual(AlyteLocalModelManifest.publicManifest() as NSDictionary))
  }

  private func makeCore(
    allowedHosts: Set<String> = ["huggingface.co", "cdn-lfs.huggingface.co"],
    protect: @escaping AlyteLocalModelCore.ProtectFile = { _ in }
  ) throws -> (AlyteLocalModelCore, URL, () -> SyntheticRuntime?) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-local-model-native-\(UUID().uuidString)")
    var runtime: SyntheticRuntime?
    let core = AlyteLocalModelCore(
      directory: root,
      expectedBytes: 5,
      expectedDigest: "valid",
      filename: "model.ready",
      allowedHosts: allowedHosts,
      hashFile: { url in String(data: try Data(contentsOf: url), encoding: .utf8) ?? "" },
      protectFile: protect,
      runtimeFactory: { _ in
        let next = SyntheticRuntime()
        runtime = next
        return next
      }
    )
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return (core, root, { runtime })
  }

  func testColdRelaunchDiscoversVerifiedReadyAndRejectsCorruptReady() throws {
    let (core, root, _) = try makeCore()
    let ready = root.appendingPathComponent("model.ready")
    _ = FileManager.default.createFile(atPath: ready.path, contents: Data("valid".utf8))
    core.reconcileInstalledPack()
    XCTAssertEqual(core.state, .ready)
    try Data("bad!!".utf8).write(to: ready)
    core.reconcileInstalledPack()
    XCTAssertEqual(core.state, .failed)
    XCTAssertEqual(core.failure, .checksumMismatch)
    XCTAssertFalse(FileManager.default.fileExists(atPath: ready.path))
  }

  func testColdRelaunchRestoresPartialAndResumesAtExactRangeOffset() throws {
    let (core, root, _) = try makeCore()
    let partial = root.appendingPathComponent(".model.ready.partial")
    try Data("va".utf8).write(to: partial)

    core.reconcileInstalledPack()
    XCTAssertEqual(core.state, .failed)
    XCTAssertEqual(core.failure, .interrupted)
    XCTAssertEqual(core.bytesReceived, 2)
    XCTAssertEqual(core.offset, 2)

    XCTAssertEqual(try core.prepareDownload(), 2)
    XCTAssertEqual(core.state, .downloading)
    XCTAssertNoThrow(try core.acceptResponse(
      status: 206,
      contentRange: "bytes 2-4/5",
      url: URL(string: "https://huggingface.co/file")!
    ))
    try core.append(Data("lid".utf8))
    guard case .succeeded = core.complete(transportFailure: nil) else {
      return XCTFail("expected resumed promotion")
    }
    XCTAssertEqual(core.state, .ready)
    XCTAssertEqual(core.bytesReceived, 5)
    XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
  }

  func testIdleTimerPolicyOnlyAwakesForegroundTransfers() {
    var policy = AlyteLocalModelIdleTimerPolicy()
    XCTAssertFalse(policy.shouldDisableIdleTimer)

    _ = policy.setState(.downloading)
    XCTAssertTrue(policy.shouldDisableIdleTimer)
    _ = policy.setState(.verifying)
    XCTAssertTrue(policy.shouldDisableIdleTimer)

    _ = policy.setState(.ready)
    XCTAssertFalse(policy.shouldDisableIdleTimer)
    _ = policy.setState(.failed)
    XCTAssertFalse(policy.shouldDisableIdleTimer)
    _ = policy.setState(.cancelling)
    XCTAssertFalse(policy.shouldDisableIdleTimer)
    _ = policy.setState(.deleting)
    XCTAssertFalse(policy.shouldDisableIdleTimer)

    _ = policy.setState(.downloading)
    _ = policy.setApplicationIsForeground(false)
    XCTAssertFalse(policy.shouldDisableIdleTimer)
    _ = policy.setApplicationIsForeground(true)
    XCTAssertTrue(policy.shouldDisableIdleTimer)
    _ = policy.setState(.notInstalled)
    XCTAssertFalse(policy.shouldDisableIdleTimer)
  }

  func testCancellationPreservesPartialButNeverReady() throws {
    let (core, _, _) = try makeCore()
    _ = try core.prepareDownload()
    try core.append(Data("part".utf8))
    core.requestCancellation()
    guard case .cancelled = core.complete(transportFailure: .cancelled) else {
      return XCTFail("expected cancellation")
    }
    XCTAssertEqual(core.state, .notInstalled)
    XCTAssertTrue(FileManager.default.fileExists(atPath: core.partialURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: core.readyURL.path))
  }

  func testCompleteInvalidPartialRestartsAndRangeFailuresAreDeterministic() throws {
    let (core, _, _) = try makeCore()
    _ = FileManager.default.createFile(atPath: core.partialURL.path, contents: Data("bad!!".utf8))
    XCTAssertEqual(try core.prepareDownload(), 0)
    XCTAssertThrowsError(try core.acceptResponse(status: 416, contentRange: nil, url: URL(string: "https://huggingface.co/file")!))
    guard case .failed = core.complete(transportFailure: nil) else { return XCTFail("expected range failure") }
    XCTAssertEqual(core.failure, .rangeRejected)
    XCTAssertFalse(FileManager.default.fileExists(atPath: core.partialURL.path))
  }

  func testRedirectAllowlistAndIgnoredRangeAreFailClosed() throws {
    let (core, root, _) = try makeCore()
    XCTAssertThrowsError(try core.acceptRedirect(URL(string: "https://evil.example/file")!))
    guard case .failed = core.complete(transportFailure: nil) else { return XCTFail("expected redirect failure") }
    XCTAssertEqual(core.failure, .redirectRejected)

    try Data("pa".utf8).write(to: root.appendingPathComponent(".model.ready.partial"))
    _ = try core.prepareDownload()
    XCTAssertThrowsError(try core.acceptResponse(status: 206, contentRange: "bytes 3-", url: URL(string: "https://cdn-lfs.huggingface.co/file")!))
    guard case .failed = core.complete(transportFailure: nil) else { return XCTFail("expected range failure") }
    XCTAssertEqual(core.failure, .rangeRejected)
  }

  func testProductionRedirectAllowlistAcceptsCurrentHuggingFaceCDNsAndRejectsLookalikes() throws {
    let productionHosts = Set(AlyteLocalModelManifest.allowedHosts)
    for host in [
      "us.aws.cdn.hf.co",
      "us.gcp.cdn.hf.co",
      "cas-server.xethub.hf.co",
      "cas-server.xethub-eu.hf.co",
      "transfer.xethub.hf.co",
      "transfer.xethub-eu.hf.co",
    ] {
      let (core, _, _) = try makeCore(allowedHosts: productionHosts)
      _ = try core.prepareDownload()
      let url = URL(string: "https://\(host)/file")!
      XCTAssertTrue(AlyteLocalModelManifest.isAllowedRedirect(url), host)
      XCTAssertNoThrow(try core.acceptRedirect(url), host)
      XCTAssertNoThrow(try core.acceptResponse(status: 200, contentRange: nil, url: url), host)
    }
    for url in [
      "http://us.aws.cdn.hf.co/file",
      "https://user:pass@us.aws.cdn.hf.co/file",
      "https://eu.aws.cdn.hf.co/file",
      "https://cdn.us.aws.cdn.hf.co/file",
      "https://example.com/file",
    ] {
      let (core, _, _) = try makeCore(allowedHosts: productionHosts)
      _ = try core.prepareDownload()
      let redirectURL = URL(string: url)!
      XCTAssertFalse(AlyteLocalModelManifest.isAllowedRedirect(redirectURL), url)
      XCTAssertThrowsError(try core.acceptRedirect(redirectURL), url)
      XCTAssertThrowsError(try core.acceptResponse(status: 200, contentRange: nil, url: redirectURL), url)
    }
  }

  func testTransportCancellationCannotEraseResponsePolicyFailure() throws {
    let (core, _, _) = try makeCore()
    _ = try core.prepareDownload()
    XCTAssertThrowsError(try core.acceptResponse(
      status: 404,
      contentRange: nil,
      url: URL(string: "https://huggingface.co/file")!
    ))
    guard case .failed = core.complete(transportFailure: .cancelled) else {
      return XCTFail("expected upstream failure")
    }
    XCTAssertEqual(core.failure, .upstreamMissing)
  }

  func testSizeChecksumAndProtectionFailuresDoNotPromote() throws {
    let (core, _, _) = try makeCore()
    _ = try core.prepareDownload()
    try core.append(Data("bad!!".utf8))
    guard case .failed = core.complete(transportFailure: nil) else { return XCTFail("expected checksum failure") }
    XCTAssertEqual(core.failure, .checksumMismatch)
    XCTAssertFalse(FileManager.default.fileExists(atPath: core.readyURL.path))

    var protectReady = false
    let (protectedCore, _, _) = try makeCore(protect: { url in
      if protectReady && url.lastPathComponent == "model.ready" {
        throw AlyteLocalModelError.failed(.storageProtection)
      }
    })
    _ = try protectedCore.prepareDownload()
    try protectedCore.append(Data("valid".utf8))
    protectReady = true
    guard case .failed = protectedCore.complete(transportFailure: nil) else { return XCTFail("expected protection failure") }
    XCTAssertEqual(protectedCore.failure, .storageProtection)
    XCTAssertFalse(FileManager.default.fileExists(atPath: protectedCore.readyURL.path))
  }

  func testAtomicReplacementRestoresPreviousReadyAfterFailure() throws {
    var failReadyProtection = false
    let (core, root, _) = try makeCore(protect: { url in
      if failReadyProtection && url.lastPathComponent == "model.ready" {
        throw AlyteLocalModelError.failed(.storageProtection)
      }
    })
    _ = FileManager.default.createFile(atPath: core.readyURL.path, contents: Data("valid".utf8))
    core.reconcileInstalledPack()
    _ = try core.prepareDownload()
    try core.append(Data("valid".utf8))
    failReadyProtection = true
    guard case .failed = core.complete(transportFailure: nil) else { return XCTFail("expected promotion failure") }
    XCTAssertEqual(try Data(contentsOf: core.readyURL), Data("valid".utf8))
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".model.ready.previous").path))
  }

  func testDeletePreservesUnrelatedHealthPathAndPressureClosesRuntime() throws {
    let (core, root, runtime) = try makeCore()
    try Data("health".utf8).write(to: root.appendingPathComponent("health.sqlite"))
    _ = FileManager.default.createFile(atPath: core.readyURL.path, contents: Data("valid".utf8))
    core.reconcileInstalledPack()
    _ = try core.load()
    let loaded = try XCTUnwrap(runtime())
    core.releaseForPressure()
    XCTAssertTrue(loaded.isClosed)
    _ = try core.delete()
    XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("health.sqlite").path))
    XCTAssertEqual(core.state, .notInstalled)
  }

  func testInferenceRequiresLoadedPackAndStopsAfterUnload() throws {
    let (core, _, _) = try makeCore()
    XCTAssertThrowsError(try core.infer(
      prompt: "synthetic",
      maxOutputTokens: 1,
      outputCapacity: 128
    ))

    _ = FileManager.default.createFile(atPath: core.readyURL.path, contents: Data("valid".utf8))
    core.reconcileInstalledPack()
    _ = try core.load()
    XCTAssertEqual(
      try core.infer(prompt: "synthetic", maxOutputTokens: 1, outputCapacity: 128),
      "{\"schemaVersion\":\"alyte.semantic-mapper.v1\",\"proposals\":[]}"
    )
    XCTAssertThrowsError(try core.infer(
      prompt: "synthetic",
      maxOutputTokens: 257,
      outputCapacity: 128
    ))

    _ = core.unload()
    XCTAssertThrowsError(try core.infer(
      prompt: "synthetic",
      maxOutputTokens: 1,
      outputCapacity: 128
    ))
  }

  func testPressureSignalsCancellationBeforeQueuedRelease() throws {
    let (core, _, runtime) = try makeCore()
    _ = FileManager.default.createFile(atPath: core.readyURL.path, contents: Data("valid".utf8))
    core.reconcileInstalledPack()
    _ = try core.load()
    let loaded = try XCTUnwrap(runtime())

    core.requestInferenceCancellation()
    XCTAssertTrue(loaded.cancellationRequested)
    XCTAssertThrowsError(try core.infer(prompt: "synthetic", maxOutputTokens: 1, outputCapacity: 128))
    core.releaseForPressure()
    XCTAssertTrue(loaded.isClosed)
  }
}
