import Foundation

public enum NativeModelState: Equatable {
  case notInstalled, downloading, failed(String), ready, loaded
}

public enum NativeModelHarnessError: Error, Equatable {
  case redirectRejected
  case rangeRejected
  case sizeMismatch
  case checksumMismatch
  case storageProtection
  case promotionFailed
}

public final class SyntheticRuntime: @unchecked Sendable {
  public private(set) var isClosed = false
  public init() {}
  public func close() { isClosed = true }
}

/// A byte-free native test seam mirroring the local module's injected filesystem/transport/runtime
/// boundaries. The test suite deliberately uses tiny synthetic artifacts and never calls the
/// production 2.84 GB URL.
public final class NativeModelHarness {
  public let directory: URL
  public let expectedBytes: Int64
  public let expectedDigest: String
  public var hash: (URL) throws -> String
  public var protect: (URL) throws -> Void
  public private(set) var state: NativeModelState = .notInstalled
  public private(set) var offset: Int64 = 0
  public private(set) var runtime: SyntheticRuntime?

  private let fileManager: FileManager
  private var forcePromotionFailure = false

  public init(
    directory: URL,
    expectedBytes: Int64 = 5,
    expectedDigest: String = "valid",
    fileManager: FileManager = .default
  ) throws {
    self.directory = directory
    self.expectedBytes = expectedBytes
    self.expectedDigest = expectedDigest
    self.fileManager = fileManager
    self.hash = { url in
      let data = try Data(contentsOf: url)
      return String(data: data, encoding: .utf8) ?? ""
    }
    self.protect = { _ in }
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  public var readyURL: URL { directory.appendingPathComponent("model.ready") }
  public var partialURL: URL { directory.appendingPathComponent(".model.partial") }
  private var backupURL: URL { directory.appendingPathComponent(".model.previous") }

  public func discover() throws {
    if fileManager.fileExists(atPath: readyURL.path) {
      do {
        try protect(readyURL)
        let size = try fileManager.attributesOfItem(atPath: readyURL.path)[.size] as? NSNumber
        guard size?.int64Value == expectedBytes else { throw NativeModelHarnessError.sizeMismatch }
        guard try hash(readyURL) == expectedDigest else { throw NativeModelHarnessError.checksumMismatch }
        state = .ready
        offset = expectedBytes
        try remove(partialURL)
      } catch let error as NativeModelHarnessError {
        try remove(readyURL)
        state = .failed(String(describing: error))
        offset = 0
      } catch {
        state = .failed(String(describing: NativeModelHarnessError.storageProtection))
      }
      return
    }
    if fileManager.fileExists(atPath: partialURL.path) {
      let size = try fileManager.attributesOfItem(atPath: partialURL.path)[.size] as? NSNumber
      offset = size?.int64Value ?? 0
      state = .failed("interrupted")
    } else {
      state = .notInstalled
      offset = 0
    }
  }

  public func begin() throws {
    if fileManager.fileExists(atPath: partialURL.path) {
      let size = try fileManager.attributesOfItem(atPath: partialURL.path)[.size] as? NSNumber
      let current = size?.int64Value ?? 0
      if current >= expectedBytes {
        try remove(partialURL)
        offset = 0
      } else {
        offset = current
      }
    } else {
      _ = fileManager.createFile(atPath: partialURL.path, contents: nil)
      offset = 0
    }
    try protect(partialURL)
    state = .downloading
  }

  public func cancel() {
    state = .notInstalled
    // Cancellation preserves a resumable partial; it never marks bytes ready.
  }

  public func setResumeOffsetForTesting(_ value: Int64) { offset = value }

  public func acceptResponse(status: Int, contentRangeStart: Int64? = nil, url: URL) throws {
    guard status == 200 || status == 206 else {
      if status == 416 {
        try remove(partialURL)
        offset = 0
        state = .failed("range-rejected")
        throw NativeModelHarnessError.rangeRejected
      }
      throw NativeModelHarnessError.promotionFailed
    }
    guard isAllowed(url) else {
      state = .failed("redirect-rejected")
      throw NativeModelHarnessError.redirectRejected
    }
    if offset > 0 && status == 206 && contentRangeStart != offset {
      try remove(partialURL)
      offset = 0
      state = .failed("range-rejected")
      throw NativeModelHarnessError.rangeRejected
    }
    if offset > 0 && status == 200 {
      try truncate(partialURL)
      offset = 0
    }
  }

  public func promote() throws {
    let size = try fileManager.attributesOfItem(atPath: partialURL.path)[.size] as? NSNumber
    guard size?.int64Value == expectedBytes else { throw NativeModelHarnessError.sizeMismatch }
    guard try hash(partialURL) == expectedDigest else { throw NativeModelHarnessError.checksumMismatch }
    try protect(partialURL)
    do {
      try remove(backupURL)
      if fileManager.fileExists(atPath: readyURL.path) {
        _ = try fileManager.replaceItemAt(
          readyURL,
          withItemAt: partialURL,
          backupItemName: backupURL.lastPathComponent,
          options: []
        )
      } else {
        try fileManager.moveItem(at: partialURL, to: readyURL)
      }
      if forcePromotionFailure { throw NativeModelHarnessError.storageProtection }
      try protect(readyURL)
      try remove(backupURL)
      state = .ready
      offset = expectedBytes
    } catch {
      if fileManager.fileExists(atPath: backupURL.path) {
        try? remove(readyURL)
        try? fileManager.moveItem(at: backupURL, to: readyURL)
      }
      throw error
    }
  }

  public func failNextPromotion() { forcePromotionFailure = true }

  public func load() throws {
    guard state == .ready else { throw NativeModelHarnessError.promotionFailed }
    runtime = SyntheticRuntime()
    state = .loaded
  }

  public func unload() {
    runtime?.close()
    runtime = nil
    if state == .loaded { state = .ready }
  }

  public func releaseForPressure() { unload() }

  public func deleteModel() throws {
    unload()
    try remove(readyURL)
    try remove(partialURL)
    state = .notInstalled
    offset = 0
  }

  private func isAllowed(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "https" &&
      ["huggingface.co", "cdn-lfs.huggingface.co"].contains(url.host?.lowercased())
  }

  private func truncate(_ url: URL) throws {
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: 0)
    try handle.close()
  }

  private func remove(_ url: URL) throws {
    guard fileManager.fileExists(atPath: url.path) else { return }
    try fileManager.removeItem(at: url)
  }
}
