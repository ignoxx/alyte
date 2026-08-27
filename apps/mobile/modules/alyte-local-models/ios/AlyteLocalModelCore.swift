import Foundation

/// Narrow runtime seam used by the production lifecycle core and by injected native tests.
protocol AlyteLocalModelRuntimeSession: AnyObject {
  func generate(prompt: String, maxOutputTokens: Int, outputCapacity: Int) throws -> String
  /// Must be non-blocking and safe to call from outside the serialized inference queue.
  func cancelInference()
  func close()
}

enum AlyteLocalModelRuntimeError: Error {
  case unavailable
  case loadFailed(AlyteLocalModelRuntimeFailureStage)
  case cancelled
}

enum AlyteLocalModelCoreCompletion {
  case succeeded([String: Any])
  case cancelled([String: Any])
  case failed(AlyteLocalModelError)
}

/// Store-facing admission result. Only `.transfer` permits the URLSession adapter to start work.
enum AlyteLocalModelDownloadAdmission {
  case ready([String: Any])
  case transfer(offset: Int64)
}

/// The production, transport-independent pack lifecycle.
///
/// URLSession, UIKit notifications, and the real llama.cpp factory are adapters around this type.
/// The core owns discovery, resumable bytes, response policy, verification, protection hooks,
/// atomic promotion, runtime cleanup, and deletion so native tests exercise the same state
/// machine used by the Expo module.
final class AlyteLocalModelCore: @unchecked Sendable {
  typealias HashFile = (URL) throws -> String
  typealias ProtectFile = (URL) throws -> Void
  typealias AvailableMemory = () -> Int64
  typealias RuntimeFactory = (URL) throws -> any AlyteLocalModelRuntimeSession

  let directory: URL
  let expectedBytes: Int64
  let expectedDigest: String
  let filename: String
  let allowedHosts: Set<String>

  private let fileManager: FileManager
  private let hashFileClosure: HashFile
  private let protectFileClosure: ProtectFile
  private let availableMemoryClosure: AvailableMemory
  private let runtimeFactory: RuntimeFactory
  // Cancellation is intentionally callable from UIKit/OS callbacks while the serialized store
  // queue is decoding. Keep pointer access separate from lifecycle work so a pressure callback
  // cannot race a runtime close and signal a stale runtime.
  private let runtimeAccessLock = NSLock()
  private var loadedRuntime: (any AlyteLocalModelRuntimeSession)?
  private var forcedFailure: AlyteLocalModelFailure?
  private var cancellationRequested = false
  private var stateValue: AlyteLocalModelState = .notInstalled
  private var failureValue: AlyteLocalModelFailure?
  private var bytesReceivedValue: Int64 = 0
  private var storageBytesValue: Int64 = 0
  private(set) var offset: Int64 = 0
  var stateObserver: (([String: Any]) -> Void)?

  private struct VerificationReceipt: Codable {
    let version: Int
    let filename: String
    let expectedBytes: Int64
    let expectedDigest: String
    let fileSize: Int64
    let modificationTimeMilliseconds: Int64?
    let fileSystemIdentifier: Int64?
  }

  private let verificationReceiptVersion = 1

  init(
    directory: URL,
    expectedBytes: Int64,
    expectedDigest: String,
    filename: String,
    allowedHosts: Set<String>,
    fileManager: FileManager = .default,
    hashFile: @escaping HashFile,
    protectFile: @escaping ProtectFile,
    availableMemory: @escaping AvailableMemory = { Int64.max },
    runtimeFactory: @escaping RuntimeFactory
  ) {
    self.directory = directory
    self.expectedBytes = expectedBytes
    self.expectedDigest = expectedDigest
    self.filename = filename
    self.allowedHosts = allowedHosts
    self.fileManager = fileManager
    self.hashFileClosure = hashFile
    self.protectFileClosure = protectFile
    self.availableMemoryClosure = availableMemory
    self.runtimeFactory = runtimeFactory
  }

  var state: AlyteLocalModelState { stateValue }
  var failure: AlyteLocalModelFailure? { failureValue }
  var bytesReceived: Int64 { bytesReceivedValue }
  var runtime: (any AlyteLocalModelRuntimeSession)? {
    runtimeAccessLock.lock()
    defer { runtimeAccessLock.unlock() }
    return loadedRuntime
  }
  var readyURL: URL { directory.appendingPathComponent(filename) }
  var partialURL: URL { directory.appendingPathComponent(".\(filename).partial") }
  private var verificationReceiptURL: URL {
    directory.appendingPathComponent(".\(filename).verification.json")
  }

  func currentState() -> [String: Any] {
    stateDictionary()
  }

  func reconcileInstalledPack() {
    do {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      try protectFileClosure(directory)
      if fileManager.fileExists(atPath: readyURL.path) {
        // Startup must stay cheap even for a multi-gigabyte pack. The receipt is a protected
        // verification record; an explicit download/recovery action is the SHA-256 boundary.
        if try verificationReceiptMatchesReadyFile() {
          storageBytesValue = expectedBytes
          bytesReceivedValue = expectedBytes
          offset = expectedBytes
          stateValue = .ready
          failureValue = nil
          try removeIfPresent(partialURL)
          emitState()
          return
        }
        storageBytesValue = expectedBytes
        bytesReceivedValue = expectedBytes
        offset = expectedBytes
        stateValue = .failed
        failureValue = .verificationRequired
        emitState()
        return
      }
      if fileManager.fileExists(atPath: partialURL.path) {
        let size = try fileSize(partialURL)
        bytesReceivedValue = min(max(size, 0), expectedBytes)
        offset = bytesReceivedValue
        stateValue = .failed
        failureValue = .interrupted
        emitState()
      } else {
        stateValue = .notInstalled
        failureValue = nil
        bytesReceivedValue = 0
        offset = 0
        emitState()
      }
    } catch let error as AlyteLocalModelError {
      fail(error)
    } catch {
      fail(.failed(.storageProtection))
    }
  }

  func verifyReady() throws -> Bool {
    try verifyReadyFile(at: readyURL, writeReceipt: true)
  }

  /// Reconciles an existing final artifact before creating any partial download state.
  func admitDownload() throws -> AlyteLocalModelDownloadAdmission {
    if stateValue == .failed || stateValue == .notInstalled {
      reconcileInstalledPack()
    }
    // A legacy/receipt-missing final artifact is never trusted from startup. A user-triggered
    // download action is the off-startup verification point where it may be recovered without
    // spending bandwidth if the authoritative digest still matches.
    if stateValue == .failed && fileManager.fileExists(atPath: readyURL.path) {
      if try verifyReady() {
        storageBytesValue = expectedBytes
        bytesReceivedValue = expectedBytes
        offset = expectedBytes
        stateValue = .ready
        failureValue = nil
        try removeIfPresent(partialURL)
        emitState()
        return .ready(stateDictionary())
      } else {
        try removeIfPresent(readyURL)
        try removeIfPresent(verificationReceiptURL)
        storageBytesValue = 0
        bytesReceivedValue = 0
        offset = 0
        stateValue = .notInstalled
        failureValue = nil
        emitState()
      }
    }
    if stateValue == .ready || stateValue == .loaded {
      guard try verifyReady() else { throw AlyteLocalModelError.failed(.checksumMismatch) }
      return .ready(stateDictionary())
    }
    return .transfer(offset: try prepareDownload())
  }

  @discardableResult
  func prepareDownload() throws -> Int64 {
    // A fresh admission is a new transfer boundary. Delete/cancel callbacks from a previous
    // operation must not carry cancellation or response-policy failure into its replacement.
    cancellationRequested = false
    forcedFailure = nil
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    try protectFileClosure(directory)
    let capacity = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
    // Production passes the six-gigabyte requirement through this explicit guard. Tiny native
    // tests use a directory with a synthetic expected size and override the resource seam below.
    if expectedBytes >= AlyteLocalModelManifest.bytes {
      guard capacity >= AlyteLocalModelManifest.minimumFreeBytes else {
        throw AlyteLocalModelError.failed(.insufficientSpace)
      }
    }
    if fileManager.fileExists(atPath: partialURL.path) {
      let size = try fileSize(partialURL)
      if size >= expectedBytes {
        try removeIfPresent(partialURL)
        offset = 0
      } else {
        offset = min(max(0, size), expectedBytes)
      }
    } else {
      offset = 0
      guard fileManager.createFile(atPath: partialURL.path, contents: nil) else {
        throw AlyteLocalModelError.failed(.runtimeFailed)
      }
    }
    try protectFileClosure(partialURL)
    bytesReceivedValue = offset
    failureValue = nil
    setState(.downloading, failure: nil)
    return offset
  }

  func requestCancellation() {
    guard stateValue == .downloading || stateValue == .verifying || stateValue == .cancelling else { return }
    cancellationRequested = true
    setState(.cancelling, failure: nil)
  }

  func acceptRedirect(_ url: URL) throws {
    guard isAllowedURL(url) else {
      forcedFailure = .redirectRejected
      throw AlyteLocalModelError.failed(.redirectRejected)
    }
  }

  func acceptResponse(status: Int, contentRange: String?, url: URL) throws {
    guard isAllowedURL(url) else {
      forcedFailure = .redirectRejected
      throw AlyteLocalModelError.failed(.redirectRejected)
    }
    guard status == 200 || status == 206 else {
      forcedFailure = status == 416 ? .rangeRejected :
        (status == 404 || status == 410 ? .upstreamMissing : .httpFailed)
      if status == 416 {
        try? removeIfPresent(partialURL)
        offset = 0
        bytesReceivedValue = 0
      }
      throw AlyteLocalModelError.failed(forcedFailure ?? .httpFailed)
    }
    if offset > 0 && status == 206 {
      guard contentRange?.hasPrefix("bytes \(offset)-") == true else {
        forcedFailure = .rangeRejected
        try? removeIfPresent(partialURL)
        offset = 0
        bytesReceivedValue = 0
        throw AlyteLocalModelError.failed(.rangeRejected)
      }
    }
    if offset > 0 && status == 200 {
      try truncate(partialURL)
      offset = 0
      bytesReceivedValue = 0
    }
  }

  func append(_ data: Data) throws {
    do {
      let handle = try FileHandle(forWritingTo: partialURL)
      try handle.seekToEnd()
      try handle.write(contentsOf: data)
      try handle.close()
      bytesReceivedValue += Int64(data.count)
      if bytesReceivedValue > expectedBytes {
        forcedFailure = .sizeMismatch
        throw AlyteLocalModelError.failed(.sizeMismatch)
      }
      emitState()
    } catch let error as AlyteLocalModelError {
      throw error
    } catch {
      forcedFailure = .runtimeFailed
      throw AlyteLocalModelError.failed(.runtimeFailed)
    }
  }

  func complete(transportFailure: AlyteLocalModelFailure?) -> AlyteLocalModelCoreCompletion {
    if cancellationRequested {
      cancellationRequested = false
      forcedFailure = nil
      setState(.notInstalled, failure: nil)
      return .cancelled(stateDictionary())
    }
    if let failure = forcedFailure ?? transportFailure {
      forcedFailure = nil
      if failure == .rangeRejected || failure == .sizeMismatch || failure == .checksumMismatch {
        try? removeIfPresent(partialURL)
        bytesReceivedValue = 0
        offset = 0
      }
      let error = AlyteLocalModelError.failed(failure)
      fail(error)
      return .failed(error)
    }
    do {
      setState(.verifying, failure: nil)
      guard try verifyAndPromote() else {
        let error = AlyteLocalModelError.failed(.checksumMismatch)
        try? removeIfPresent(partialURL)
        bytesReceivedValue = 0
        offset = 0
        fail(error)
        return .failed(error)
      }
      setState(.ready, failure: nil)
      return .succeeded(stateDictionary())
    } catch let error as AlyteLocalModelError {
      if error.failure == .sizeMismatch || error.failure == .checksumMismatch {
        try? removeIfPresent(partialURL)
        bytesReceivedValue = 0
        offset = 0
      }
      fail(error)
      return .failed(error)
    } catch {
      let localError = AlyteLocalModelError.failed(.runtimeFailed)
      fail(localError)
      return .failed(localError)
    }
  }

  func load() throws -> [String: Any] {
    if expectedBytes >= AlyteLocalModelManifest.bytes {
      guard ProcessInfo.processInfo.physicalMemory >= AlyteLocalModelManifest.minimumMemoryBytes else {
        throw AlyteLocalModelError.failed(.incompatible)
      }
      // `physicalMemory` is a device-class signal, not an admission decision. The process may
      // already be close to its iOS dirty-memory limit after OCR or PDF work. This current,
      // uncached sample prevents a model allocation from becoming the next Jetsam victim.
      guard availableMemoryClosure() >= AlyteLocalModelManifest.minimumMemoryBytes else {
        throw AlyteLocalModelError.failed(.incompatible)
      }
    }
    // Ordinary extraction activation uses the cheap protected receipt identity check. A missing
    // or changed receipt is a closed gate; an explicit retry/download action is the only path
    // that performs the authoritative SHA-256 re-verification of the multi-gigabyte artifact.
    try protectFileClosure(readyURL)
    guard try verificationReceiptMatchesReadyFile() else {
      throw AlyteLocalModelError.failed(.verificationRequired)
    }
    if stateValue == .failed { setState(.ready, failure: nil) }
    releaseLoadedModel()
    do {
      let runtime = try runtimeFactory(readyURL)
      runtimeAccessLock.lock()
      loadedRuntime = runtime
      runtimeAccessLock.unlock()
    } catch let error as AlyteLocalModelRuntimeError {
      switch error {
      case .unavailable: throw AlyteLocalModelError.unavailable(.unavailable)
      case .loadFailed(let stage): throw AlyteLocalModelError.runtimeFailed(stage)
      case .cancelled: throw AlyteLocalModelError.failed(.cancelled)
      }
    } catch {
      throw AlyteLocalModelError.failed(.runtimeFailed)
    }
    setState(.loaded, failure: nil)
    return stateDictionary()
  }

  /// Activates verified bytes while keeping transient runtime failures separate from transfer
  /// integrity. The Store calls this boundary directly, and a retry can reuse the same final file.
  func activateVerifiedPack() throws -> [String: Any] {
    do {
      return try load()
    } catch {
      let localError = (error as? AlyteLocalModelError) ?? .failed(.runtimeFailed)
      if localError.failure != .unavailable &&
          localError.failure != .runtimeFailed &&
          localError.failure != .incompatible &&
          localError.failure != .cancelled {
        fail(localError)
      }
      throw localError
    }
  }

  func infer(prompt: String, maxOutputTokens: Int, outputCapacity: Int) throws -> String {
    guard stateValue == .loaded, let loadedRuntime else {
      throw AlyteLocalModelError.unavailable(.unavailable)
    }
    guard maxOutputTokens > 0, maxOutputTokens <= 256, outputCapacity > 0, outputCapacity <= 16_384 else {
      throw AlyteLocalModelError.failed(.runtimeFailed)
    }
    return try loadedRuntime.generate(
      prompt: prompt,
      maxOutputTokens: maxOutputTokens,
      outputCapacity: outputCapacity
    )
  }

  /// Signals the C generation loop directly. It intentionally does not touch lifecycle state or
  /// wait for the store queue, so memory/thermal callbacks can interrupt an in-flight decode.
  func requestInferenceCancellation() {
    runtimeAccessLock.lock()
    loadedRuntime?.cancelInference()
    runtimeAccessLock.unlock()
  }

  func unload() -> [String: Any] {
    releaseLoadedModel()
    if fileManager.fileExists(atPath: readyURL.path) { setState(.ready, failure: nil) }
    return stateDictionary()
  }

  func releaseForPressure() {
    requestInferenceCancellation()
    releaseLoadedModel()
  }

  func delete() throws -> [String: Any] {
    cancellationRequested = false
    forcedFailure = nil
    releaseLoadedModel()
    try removeIfPresent(readyURL)
    try removeIfPresent(partialURL)
    try removeIfPresent(verificationReceiptURL)
    storageBytesValue = 0
    bytesReceivedValue = 0
    offset = 0
    setState(.notInstalled, failure: nil)
    return stateDictionary()
  }

  func markFailed(_ error: AlyteLocalModelError) {
    fail(error)
  }

  private func isAllowedURL(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "https" &&
      url.user == nil &&
      url.password == nil &&
      allowedHosts.contains(url.host?.lowercased() ?? "")
  }

  private func verifyAndPromote() throws -> Bool {
    guard fileManager.fileExists(atPath: partialURL.path) else {
      throw AlyteLocalModelError.failed(.sizeMismatch)
    }
    guard try fileSize(partialURL) == expectedBytes else {
      throw AlyteLocalModelError.failed(.sizeMismatch)
    }
    guard try hashFileClosure(partialURL) == expectedDigest else {
      throw AlyteLocalModelError.failed(.checksumMismatch)
    }
    try protectFileClosure(partialURL)
    let backup = directory.appendingPathComponent(".\(filename).previous")
    let receiptBackup = directory.appendingPathComponent(".\(filename).verification.previous")
    do {
      try removeIfPresent(backup)
      try removeIfPresent(receiptBackup)
      if fileManager.fileExists(atPath: verificationReceiptURL.path) {
        try fileManager.copyItem(at: verificationReceiptURL, to: receiptBackup)
      }
      if fileManager.fileExists(atPath: readyURL.path) {
        // Keep an explicit sibling backup because replaceItemAt's optional backup name is not
        // consistently materialized across iOS filesystem providers. The ready item remains in
        // place until the atomic replacement call, and this copy lets a post-promotion check
        // restore the previous verified pack deterministically.
        try fileManager.copyItem(at: readyURL, to: backup)
        _ = try fileManager.replaceItemAt(readyURL, withItemAt: partialURL, backupItemName: nil, options: [])
      } else {
        try fileManager.moveItem(at: partialURL, to: readyURL)
      }
      try protectFileClosure(readyURL)
      try writeVerificationReceipt(for: readyURL)
      try removeIfPresent(backup)
      try removeIfPresent(receiptBackup)
    } catch {
      try? removeIfPresent(verificationReceiptURL)
      if fileManager.fileExists(atPath: receiptBackup.path) {
        try? fileManager.moveItem(at: receiptBackup, to: verificationReceiptURL)
      }
      if fileManager.fileExists(atPath: backup.path) {
        try? removeIfPresent(readyURL)
        try? fileManager.moveItem(at: backup, to: readyURL)
      } else {
        try? removeIfPresent(readyURL)
      }
      throw error
    }
    storageBytesValue = expectedBytes
    return true
  }

  private func verifyReadyFile(at url: URL, writeReceipt: Bool) throws -> Bool {
    guard fileManager.fileExists(atPath: url.path) else { return false }
    try protectFileClosure(url)
    guard try fileSize(url) == expectedBytes else { return false }
    guard try hashFileClosure(url) == expectedDigest else { return false }
    if writeReceipt { try writeVerificationReceipt(for: url) }
    return true
  }

  private func verificationReceiptMatchesReadyFile() throws -> Bool {
    guard fileManager.fileExists(atPath: verificationReceiptURL.path) else { return false }
    guard let data = try? Data(contentsOf: verificationReceiptURL) else { return false }
    guard let receipt = try? JSONDecoder().decode(VerificationReceipt.self, from: data) else {
      return false
    }
    guard receipt.version == verificationReceiptVersion,
      receipt.filename == filename,
      receipt.expectedBytes == expectedBytes,
      receipt.expectedDigest == expectedDigest,
      let attributes = try? fileManager.attributesOfItem(atPath: readyURL.path),
      let size = (attributes[.size] as? NSNumber)?.int64Value,
      size == receipt.fileSize,
      size == expectedBytes,
      Self.int64(from: attributes[.systemFileNumber]) == receipt.fileSystemIdentifier
    else { return false }
    let modificationTime = Self.milliseconds(from: attributes[.modificationDate])
    return modificationTime == receipt.modificationTimeMilliseconds
  }

  private func writeVerificationReceipt(for url: URL) throws {
    let attributes = try fileManager.attributesOfItem(atPath: url.path)
    guard let size = (attributes[.size] as? NSNumber)?.int64Value, size == expectedBytes else {
      throw AlyteLocalModelError.failed(.sizeMismatch)
    }
    let receipt = VerificationReceipt(
      version: verificationReceiptVersion,
      filename: filename,
      expectedBytes: expectedBytes,
      expectedDigest: expectedDigest,
      fileSize: size,
      modificationTimeMilliseconds: Self.milliseconds(from: attributes[.modificationDate]),
      fileSystemIdentifier: Self.int64(from: attributes[.systemFileNumber])
    )
    let temporaryURL = directory.appendingPathComponent(".\(filename).verification.partial")
    try removeIfPresent(temporaryURL)
    do {
      let data = try JSONEncoder().encode(receipt)
      guard fileManager.createFile(atPath: temporaryURL.path, contents: data) else {
        throw AlyteLocalModelError.failed(.runtimeFailed)
      }
      try protectFileClosure(temporaryURL)
      if fileManager.fileExists(atPath: verificationReceiptURL.path) {
        _ = try fileManager.replaceItemAt(
          verificationReceiptURL,
          withItemAt: temporaryURL,
          backupItemName: nil,
          options: []
        )
      } else {
        try fileManager.moveItem(at: temporaryURL, to: verificationReceiptURL)
      }
      try protectFileClosure(verificationReceiptURL)
    } catch {
      try? removeIfPresent(temporaryURL)
      throw error
    }
  }

  private static func milliseconds(from value: Any?) -> Int64? {
    guard let date = value as? Date else { return nil }
    return Int64((date.timeIntervalSince1970 * 1_000).rounded())
  }

  private static func int64(from value: Any?) -> Int64? {
    (value as? NSNumber)?.int64Value
  }

  private func fileSize(_ url: URL) throws -> Int64 {
    (try fileManager.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? -1
  }

  private func truncate(_ url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: 0)
    try handle.close()
  }

  private func removeIfPresent(_ url: URL) throws {
    guard fileManager.fileExists(atPath: url.path) else { return }
    try fileManager.removeItem(at: url)
    guard !fileManager.fileExists(atPath: url.path) else {
      throw AlyteLocalModelError.failed(.runtimeFailed)
    }
  }

  private func releaseLoadedModel() {
    runtimeAccessLock.lock()
    let runtime = loadedRuntime
    loadedRuntime = nil
    runtimeAccessLock.unlock()
    runtime?.close()
    if stateValue == .loaded { setState(.ready, failure: nil) }
  }

  private func fail(_ error: AlyteLocalModelError) {
    failureValue = error.failure
    stateValue = .failed
    emitState()
  }

  private func setState(_ value: AlyteLocalModelState, failure: AlyteLocalModelFailure?) {
    stateValue = value
    failureValue = failure
    emitState()
  }

  private func emitState() { stateObserver?(stateDictionary()) }

  private func stateDictionary() -> [String: Any] {
    AlyteLocalModelSnapshot(
      state: stateValue,
      bytesReceived: bytesReceivedValue,
      storageBytes: storageBytesValue,
      failure: failureValue
    ).dictionary
  }
}
