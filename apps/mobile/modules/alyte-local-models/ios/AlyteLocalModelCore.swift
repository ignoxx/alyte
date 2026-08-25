import Foundation

/// Narrow runtime seam used by the production lifecycle core and by injected native tests.
protocol AlyteLocalModelRuntimeSession: AnyObject {
  func close()
}

enum AlyteLocalModelRuntimeError: Error {
  case unavailable
  case loadFailed
}

enum AlyteLocalModelCoreCompletion {
  case succeeded([String: Any])
  case cancelled([String: Any])
  case failed(AlyteLocalModelError)
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
  typealias RuntimeFactory = (URL) throws -> any AlyteLocalModelRuntimeSession

  let directory: URL
  let expectedBytes: Int64
  let expectedDigest: String
  let filename: String
  let allowedHosts: Set<String>

  private let fileManager: FileManager
  private let hashFileClosure: HashFile
  private let protectFileClosure: ProtectFile
  private let runtimeFactory: RuntimeFactory
  private var loadedRuntime: (any AlyteLocalModelRuntimeSession)?
  private var forcedFailure: AlyteLocalModelFailure?
  private var cancellationRequested = false
  private var stateValue: AlyteLocalModelState = .notInstalled
  private var failureValue: AlyteLocalModelFailure?
  private var bytesReceivedValue: Int64 = 0
  private var storageBytesValue: Int64 = 0
  private(set) var offset: Int64 = 0
  var stateObserver: (([String: Any]) -> Void)?

  init(
    directory: URL,
    expectedBytes: Int64,
    expectedDigest: String,
    filename: String,
    allowedHosts: Set<String>,
    fileManager: FileManager = .default,
    hashFile: @escaping HashFile,
    protectFile: @escaping ProtectFile,
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
    self.runtimeFactory = runtimeFactory
  }

  var state: AlyteLocalModelState { stateValue }
  var failure: AlyteLocalModelFailure? { failureValue }
  var bytesReceived: Int64 { bytesReceivedValue }
  var runtime: (any AlyteLocalModelRuntimeSession)? { loadedRuntime }
  var readyURL: URL { directory.appendingPathComponent(filename) }
  var partialURL: URL { directory.appendingPathComponent(".\(filename).partial") }

  func currentState() -> [String: Any] {
    stateDictionary()
  }

  func reconcileInstalledPack() {
    do {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      try protectFileClosure(directory)
      if fileManager.fileExists(atPath: readyURL.path) {
        guard try verifyReadyFile(at: readyURL) else {
          try removeIfPresent(readyURL)
          stateValue = .failed
          failureValue = .checksumMismatch
          emitState()
          return
        }
        storageBytesValue = expectedBytes
        bytesReceivedValue = expectedBytes
        offset = expectedBytes
        stateValue = .ready
        failureValue = nil
        try removeIfPresent(partialURL)
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
    try verifyReadyFile(at: readyURL)
  }

  @discardableResult
  func prepareDownload() throws -> Int64 {
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
    }
    guard try verifyReady() else { throw AlyteLocalModelError.failed(.checksumMismatch) }
    releaseLoadedModel()
    do {
      loadedRuntime = try runtimeFactory(readyURL)
    } catch let error as AlyteLocalModelRuntimeError {
      switch error {
      case .unavailable: throw AlyteLocalModelError.unavailable(.unavailable)
      case .loadFailed: throw AlyteLocalModelError.failed(.runtimeFailed)
      }
    } catch {
      throw AlyteLocalModelError.failed(.runtimeFailed)
    }
    setState(.loaded, failure: nil)
    return stateDictionary()
  }

  func unload() -> [String: Any] {
    releaseLoadedModel()
    if fileManager.fileExists(atPath: readyURL.path) { setState(.ready, failure: nil) }
    return stateDictionary()
  }

  func releaseForPressure() {
    releaseLoadedModel()
  }

  func delete() throws -> [String: Any] {
    releaseLoadedModel()
    try removeIfPresent(readyURL)
    try removeIfPresent(partialURL)
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
    do {
      try removeIfPresent(backup)
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
      try removeIfPresent(backup)
    } catch {
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

  private func verifyReadyFile(at url: URL) throws -> Bool {
    guard fileManager.fileExists(atPath: url.path) else { return false }
    try protectFileClosure(url)
    guard try fileSize(url) == expectedBytes else { return false }
    return try hashFileClosure(url) == expectedDigest
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
    loadedRuntime?.close()
    loadedRuntime = nil
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
