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
    protect: @escaping AlyteLocalModelCore.ProtectFile = { _ in },
    hashFile: @escaping AlyteLocalModelCore.HashFile = { url in
      String(data: try Data(contentsOf: url), encoding: .utf8) ?? ""
    },
    availableMemory: @escaping AlyteLocalModelCore.AvailableMemory = { Int64.max }
  ) throws -> (AlyteLocalModelCore, URL, () -> SyntheticRuntime?) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-local-model-native-\(UUID().uuidString)")
    var runtime: SyntheticRuntime?
    let core = AlyteLocalModelCore(
      directory: root,
      expectedBytes: 5,
      expectedDigest: "valid",
      filename: "model.ready",
      allowedHosts: allowedHosts,
      hashFile: hashFile,
      protectFile: protect,
      availableMemory: availableMemory,
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

  func testColdRelaunchUsesReceiptAndDefersAuthoritativeHash() throws {
    var hashCalls = 0
    let (core, root, _) = try makeCore(hashFile: { url in
      hashCalls += 1
      return String(data: try Data(contentsOf: url), encoding: .utf8) ?? ""
    })
    _ = try core.prepareDownload()
    try core.append(Data("valid".utf8))
    guard case .succeeded = core.complete(transportFailure: nil) else {
      return XCTFail("expected verified promotion")
    }
    XCTAssertEqual(core.state, .ready)
    XCTAssertEqual(hashCalls, 1)

    // The first verification happened during promotion. A cold-state reconciliation with a
    // matching receipt must not hash the final artifact again.
    core.reconcileInstalledPack()
    XCTAssertEqual(core.state, .ready)
    XCTAssertEqual(hashCalls, 1)

    // Ordinary activation trusts only the protected receipt identity, so a verified relaunch
    // remains cheap even when it immediately loads the runtime.
    _ = try core.load()
    XCTAssertEqual(hashCalls, 1)

    let ready = root.appendingPathComponent("model.ready")
    try Data("bad!!".utf8).write(to: ready)
    core.reconcileInstalledPack()
    XCTAssertEqual(core.state, .failed)
    XCTAssertEqual(core.failure, .verificationRequired)
    XCTAssertTrue(FileManager.default.fileExists(atPath: ready.path))

    // A user-triggered retry is the authoritative verification boundary. A bad final artifact
    // is discarded only there, and the network resumes from a fresh offset.
    guard case .transfer(let offset) = try core.admitDownload() else {
      return XCTFail("bad final artifact should enter a fresh transfer")
    }
    XCTAssertEqual(offset, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: ready.path))
  }

  func testCurrentAvailableMemoryAdmissionFailsClosedBeforeRuntimeActivation() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "alyte-local-model-memory-admission-\(UUID().uuidString)"
    )
    let core = AlyteLocalModelCore(
      directory: root,
      expectedBytes: AlyteLocalModelManifest.bytes,
      expectedDigest: AlyteLocalModelManifest.sha256,
      filename: AlyteLocalModelManifest.filename,
      allowedHosts: Set(AlyteLocalModelManifest.allowedHosts),
      hashFile: { _ in XCTFail("memory admission must precede verification"); return "" },
      protectFile: { _ in },
      availableMemory: { 1 },
      runtimeFactory: { _ in XCTFail("memory admission must precede runtime activation"); return SyntheticRuntime() }
    )
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }

    XCTAssertThrowsError(try core.load()) { error in
      guard case .failed(let failure) = error as? AlyteLocalModelError else {
        return XCTFail("expected typed incompatibility")
      }
      XCTAssertEqual(failure, .incompatible)
    }
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

  func testRuntimeActivationFailureKeepsVerifiedPackAvailableForRetry() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alyte-local-model-runtime-retry-\(UUID().uuidString)")
    var shouldFail = true
    let core = AlyteLocalModelCore(
      directory: root,
      expectedBytes: 5,
      expectedDigest: "valid",
      filename: "model.ready",
      allowedHosts: ["huggingface.co"],
      hashFile: { url in String(data: try Data(contentsOf: url), encoding: .utf8) ?? "" },
      protectFile: { _ in },
      runtimeFactory: { _ in
        if shouldFail { throw AlyteLocalModelRuntimeError.unavailable }
        return SyntheticRuntime()
      }
    )
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    _ = try core.prepareDownload()
    try core.append(Data("valid".utf8))
    guard case .succeeded = core.complete(transportFailure: nil) else {
      return XCTFail("expected verified promotion")
    }
    XCTAssertEqual(core.state, .ready)
    XCTAssertThrowsError(try core.activateVerifiedPack())
    XCTAssertEqual(core.state, .ready)
    XCTAssertEqual(core.failure, nil)
    XCTAssertTrue(FileManager.default.fileExists(atPath: core.readyURL.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: core.partialURL.path))

    // This is the exact admission boundary called by Store before URLSession can begin. A ready
    // result proves neither a partial nor a network transfer is admitted after activation fails.
    switch try core.admitDownload() {
    case .ready(let state):
      XCTAssertEqual(state["state"] as? String, "ready")
    case .transfer:
      XCTFail("verified final artifact must not admit a network transfer")
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: core.partialURL.path))
    shouldFail = false
    XCTAssertEqual(try core.activateVerifiedPack()["state"] as? String, "loaded")
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

  func testStoreIdleTimerCoordinatorDropsPendingEnableAfterBackground() {
    var pending: [() -> Void] = []
    var value = false
    var writes: [Bool] = []
    let coordinator = AlyteLocalModelIdleTimerCoordinator(
      schedule: { pending.append($0) },
      valueReader: { value },
      valueWriter: { next in
        value = next
        writes.append(next)
      }
    )

    coordinator.stateChanged(.downloading)
    coordinator.setApplicationIsForeground(false)
    XCTAssertEqual(pending.count, 2)

    // Model state delivery is stale once the lifecycle callback has claimed the newer token.
    pending[1]()
    pending[0]()
    XCTAssertEqual(writes, [])
    XCTAssertFalse(value)
  }

  func testStoreIdleTimerCoordinatorReappliesLatestDownloadAfterForeground() {
    var pending: [() -> Void] = []
    var value = false
    var writes: [Bool] = []
    let coordinator = AlyteLocalModelIdleTimerCoordinator(
      schedule: { pending.append($0) },
      valueReader: { value },
      valueWriter: { next in
        value = next
        writes.append(next)
      }
    )

    coordinator.stateChanged(.downloading)
    coordinator.setApplicationIsForeground(false)
    pending[1]()
    pending[0]()
    pending.removeAll()
    XCTAssertEqual(writes, [])

    coordinator.setApplicationIsForeground(true)
    pending.removeFirst()()
    XCTAssertEqual(writes, [true])
    XCTAssertTrue(value)
  }

  func testStoreIdleTimerCoordinatorDropsPendingEnableAfterTeardown() {
    var pending: [() -> Void] = []
    var value = false
    var writes: [Bool] = []
    let coordinator = AlyteLocalModelIdleTimerCoordinator(
      schedule: { pending.append($0) },
      valueReader: { value },
      valueWriter: { next in
        value = next
        writes.append(next)
      }
    )

    coordinator.stateChanged(.downloading)
    coordinator.teardown()
    XCTAssertEqual(pending.count, 2)

    pending[1]()
    pending[0]()
    XCTAssertEqual(writes, [])
    XCTAssertFalse(value)
  }

  func testStoreIdleTimerCoordinatorRestoresPriorValueOnTeardown() {
    var pending: [() -> Void] = []
    var value = false
    var writes: [Bool] = []
    let coordinator = AlyteLocalModelIdleTimerCoordinator(
      schedule: { pending.append($0) },
      valueReader: { value },
      valueWriter: { next in
        value = next
        writes.append(next)
      }
    )

    coordinator.stateChanged(.verifying)
    pending.removeFirst()()
    XCTAssertEqual(writes, [true])
    XCTAssertTrue(value)

    coordinator.teardown()
    pending.removeFirst()()
    XCTAssertEqual(writes, [true, false])
    XCTAssertFalse(value)
  }

  func testStoreIdleTimerCoordinatorDoesNotChangePreexistingDisabledValue() {
    var pending: [() -> Void] = []
    var value = true
    var writes: [Bool] = []
    let coordinator = AlyteLocalModelIdleTimerCoordinator(
      schedule: { pending.append($0) },
      valueReader: { value },
      valueWriter: { next in
        value = next
        writes.append(next)
      }
    )

    coordinator.stateChanged(.downloading)
    pending.removeFirst()()
    coordinator.teardown()
    pending.removeFirst()()
    XCTAssertEqual(writes, [])
    XCTAssertTrue(value)
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
    XCTAssertTrue(try core.verifyReady())
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
    XCTAssertTrue(try core.verifyReady())
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
    XCTAssertTrue(try core.verifyReady())
    _ = try core.load()
    let loaded = try XCTUnwrap(runtime())

    core.requestInferenceCancellation()
    XCTAssertTrue(loaded.cancellationRequested)
    XCTAssertThrowsError(try core.infer(prompt: "synthetic", maxOutputTokens: 1, outputCapacity: 128))
    core.releaseForPressure()
    XCTAssertTrue(loaded.isClosed)
  }
}
