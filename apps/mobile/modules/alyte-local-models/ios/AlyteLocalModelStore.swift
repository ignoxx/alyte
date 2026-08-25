import CryptoKit
import Foundation
import UIKit

/// Owns the model bytes and lifecycle. No file path, URL, prompt, token, OCR value, or inference
/// output crosses the module boundary. The #52 mapper will attach its runtime to `load`; this
/// ticket deliberately keeps the provider-neutral lifecycle contract and never bundles weights.
final class AlyteLocalModelStore: NSObject, @unchecked Sendable, URLSessionDataDelegate, URLSessionTaskDelegate {
  typealias StateObserver = ([String: Any]) -> Void

  private let fileManager: FileManager
  private let queue = DispatchQueue(label: "com.alyte.local-models", qos: .utility)
  private var session: URLSession?
  private var downloadTask: URLSessionDataTask?
  private var downloadCompletion: ((Result<[String: Any], Error>) -> Void)?
  private var cancelCompletion: ((Result<[String: Any], Error>) -> Void)?
  private var forcedFailure: AlyteLocalModelFailure?
  private var offset: Int64 = 0
  private var loadedHandle: FileHandle?
  private var stateValue = "not-installed"
  private var bytesReceived: Int64 = 0
  private var failureValue: AlyteLocalModelFailure?
  private var lastStorageBytes: Int64 = 0
  var stateObserver: StateObserver?

  init(fileManager: FileManager = .default) {
    self.fileManager = fileManager
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(memoryWarning),
      name: UIApplication.didReceiveMemoryWarningNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(thermalStateChanged),
      name: ProcessInfo.thermalStateDidChangeNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    releaseLoadedModel()
    session?.invalidateAndCancel()
  }

  func manifest() -> [String: Any] { AlyteLocalModelManifest.publicManifest() }

  func currentState() -> [String: Any] {
    queue.sync { stateDictionary() }
  }

  func startDownload(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          if self.stateValue == "ready" || self.stateValue == "loaded" {
            guard try self.verifyReadyFile() else { throw AlyteLocalModelError.failed(.checksumMismatch) }
            continuation.resume(returning: self.stateDictionary())
            return
          }
          if self.downloadTask != nil {
            continuation.resume(returning: self.stateDictionary())
            return
          }
          try self.prepareDownload()
          self.beginDownload { result in
            continuation.resume(with: result)
          }
        } catch {
          self.fail(error)
          continuation.resume(throwing: error)
        }
      }
    }
  }

  func cancelDownload() async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard self.downloadTask != nil else {
          continuation.resume(returning: self.stateDictionary())
          return
        }
        self.setState("cancelling", failure: nil)
        self.forcedFailure = .cancelled
        self.downloadTask?.cancel()
        self.cancelCompletion = { result in
          switch result {
          case .success(let state): continuation.resume(returning: state)
          case .failure(let error):
            // Cancellation is an expected user action, so return the safe disclosure state rather
            // than surfacing a transport error to the onboarding gate.
            self.setState("not-installed", failure: nil)
            continuation.resume(returning: self.stateDictionary())
            _ = error
          }
        }
      }
    }
  }

  func load(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          guard ProcessInfo.processInfo.physicalMemory >= AlyteLocalModelManifest.minimumMemoryBytes else {
            throw AlyteLocalModelError.failed(.incompatible)
          }
          guard try self.verifyReadyFile() else { throw AlyteLocalModelError.failed(.checksumMismatch) }
          self.releaseLoadedModel()
          self.loadedHandle = try FileHandle(forReadingFrom: self.readyURL())
          self.setState("loaded", failure: nil)
          continuation.resume(returning: self.stateDictionary())
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          self.fail(localError)
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  func unload() -> [String: Any] {
    queue.sync {
      releaseLoadedModel()
      if fileManager.fileExists(atPath: readyURL().path) { setState("ready", failure: nil) }
      return stateDictionary()
    }
  }

  func deletePack(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        self.setState("deleting", failure: nil)
        let pendingDownload = self.downloadCompletion
        self.downloadCompletion = nil
        self.forcedFailure = self.downloadTask == nil ? nil : .cancelled
        self.downloadTask?.cancel()
        self.downloadTask = nil
        self.releaseLoadedModel()
        do {
          try self.removeIfPresent(self.readyURL())
          try self.removeIfPresent(self.partialURL())
          try self.removeIfPresent(self.resumeURL())
          self.lastStorageBytes = 0
          self.bytesReceived = 0
          self.setState("not-installed", failure: nil)
          pendingDownload?(.failure(AlyteLocalModelError.failed(.cancelled)))
          continuation.resume(returning: self.stateDictionary())
        } catch {
          self.fail(AlyteLocalModelError.failed(.runtimeFailed))
          pendingDownload?(.failure(AlyteLocalModelError.failed(.runtimeFailed)))
          continuation.resume(throwing: AlyteLocalModelError.failed(.runtimeFailed))
        }
      }
    }
  }

  func releaseForBackground() {
    queue.async {
      self.releaseLoadedModel()
      if self.stateValue == "loaded" { self.setState("ready", failure: nil) }
    }
  }

  @objc private func memoryWarning() {
    releaseForBackground()
  }

  @objc private func thermalStateChanged() {
    if ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical {
      releaseForBackground()
    }
  }

  private func modelDirectory() throws -> URL {
    let root = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ).appendingPathComponent("Alyte/Models", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    try protect(root)
    return root
  }

  private func readyURL() -> URL { (try? modelDirectory())?.appendingPathComponent(AlyteLocalModelManifest.filename) ?? URL(fileURLWithPath: "") }
  private func partialURL() -> URL { (try? modelDirectory())?.appendingPathComponent(".\(AlyteLocalModelManifest.filename).partial") ?? URL(fileURLWithPath: "") }
  private func resumeURL() -> URL { (try? modelDirectory())?.appendingPathComponent(".\(AlyteLocalModelManifest.filename).resume") ?? URL(fileURLWithPath: "") }

  private func prepareDownload() throws {
    guard #available(iOS 26.0, *) else { throw AlyteLocalModelError.failed(.incompatible) }
    let directory = try modelDirectory()
    let capacity = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
    guard capacity >= AlyteLocalModelManifest.minimumFreeBytes else {
      throw AlyteLocalModelError.failed(.insufficientSpace)
    }
    let partial = partialURL()
    if fileManager.fileExists(atPath: partial.path) {
      let size = (try? fileManager.attributesOfItem(atPath: partial.path)[.size] as? NSNumber)?.int64Value ?? 0
      if size > AlyteLocalModelManifest.bytes {
        try removeIfPresent(partial)
        offset = 0
      } else {
        offset = min(max(0, size), AlyteLocalModelManifest.bytes)
      }
    } else {
      offset = 0
      guard fileManager.createFile(atPath: partial.path, contents: nil) else {
        throw AlyteLocalModelError.failed(.runtimeFailed)
      }
    }
    try protect(partial)
    bytesReceived = offset
    failureValue = nil
    setState("downloading", failure: nil)
  }

  private func beginDownload(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    downloadCompletion = completion
    var request = URLRequest(url: AlyteLocalModelManifest.expectedURL)
    request.httpMethod = "GET"
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = false
    request.setValue(nil, forHTTPHeaderField: "Authorization")
    request.setValue(nil, forHTTPHeaderField: "Cookie")
    if offset > 0 { request.setValue("bytes=\(offset)-", forHTTPHeaderField: "Range") }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    downloadTask = session?.dataTask(with: request)
    downloadTask?.resume()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    guard AlyteLocalModelManifest.isAllowedRedirect(request.url ?? URL(fileURLWithPath: "")) else {
      forcedFailure = .redirectRejected
      completionHandler(nil)
      return
    }
    var next = request
    next.setValue(nil, forHTTPHeaderField: "Authorization")
    next.setValue(nil, forHTTPHeaderField: "Cookie")
    completionHandler(next)
    _ = session
    _ = task
    _ = response
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 || http.statusCode == 206 else {
      forcedFailure = httpStatusFailure(response)
      completionHandler(.cancel)
      return
    }
    if offset > 0 && http.statusCode == 200 {
      offset = 0
      bytesReceived = 0
      if let handle = try? FileHandle(forWritingTo: partialURL()) {
        try? handle.truncate(atOffset: 0)
        try? handle.close()
      }
    }
    completionHandler(.allow)
    _ = session
    _ = dataTask
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    queue.async {
      guard self.stateValue == "downloading" else { return }
      do {
        let handle = try FileHandle(forWritingTo: self.partialURL())
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.close()
        self.bytesReceived += Int64(data.count)
        if self.bytesReceived > AlyteLocalModelManifest.bytes {
          self.forcedFailure = .sizeMismatch
          dataTask.cancel()
          return
        }
        self.emitState()
      } catch {
        self.forcedFailure = .runtimeFailed
        dataTask.cancel()
      }
    }
    _ = session
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    queue.async {
      self.downloadTask = nil
      self.session?.invalidateAndCancel()
      self.session = nil
      let completion = self.downloadCompletion
      self.downloadCompletion = nil
      let cancelCompletion = self.cancelCompletion
      self.cancelCompletion = nil
      if let forced = self.forcedFailure {
        self.forcedFailure = nil
        if forced == .cancelled {
          self.setState("not-installed", failure: nil)
          completion?(.failure(AlyteLocalModelError.failed(.cancelled)))
          cancelCompletion?(.success(self.stateDictionary()))
        } else {
          self.fail(AlyteLocalModelError.failed(forced))
          completion?(.failure(AlyteLocalModelError.failed(forced)))
          cancelCompletion?(.failure(AlyteLocalModelError.failed(forced)))
        }
        return
      }
      if let error {
        let failure = self.networkFailure(error)
        self.fail(AlyteLocalModelError.failed(failure))
        completion?(.failure(AlyteLocalModelError.failed(failure)))
        cancelCompletion?(.failure(AlyteLocalModelError.failed(failure)))
        return
      }
      do {
        self.setState("verifying", failure: nil)
        guard try self.verifyAndPromote() else {
          self.fail(AlyteLocalModelError.failed(.checksumMismatch))
          completion?(.failure(AlyteLocalModelError.failed(.checksumMismatch)))
          cancelCompletion?(.failure(AlyteLocalModelError.failed(.checksumMismatch)))
          return
        }
        self.setState("ready", failure: nil)
        completion?(.success(self.stateDictionary()))
        cancelCompletion?(.success(self.stateDictionary()))
      } catch {
        self.fail(error)
        completion?(.failure(error))
        cancelCompletion?(.failure(error))
      }
    }
    _ = session
    _ = task
  }

  private func verifyAndPromote() throws -> Bool {
    let partial = partialURL()
    guard fileManager.fileExists(atPath: partial.path) else { throw AlyteLocalModelError.failed(.sizeMismatch) }
    let size = (try fileManager.attributesOfItem(atPath: partial.path)[.size] as? NSNumber)?.int64Value ?? -1
    guard size == AlyteLocalModelManifest.bytes else { throw AlyteLocalModelError.failed(.sizeMismatch) }
    let hash = try hashFile(partial)
    guard hash == AlyteLocalModelManifest.sha256 else { throw AlyteLocalModelError.failed(.checksumMismatch) }
    try protect(partial)
    let ready = readyURL()
    try removeIfPresent(ready)
    try fileManager.moveItem(at: partial, to: ready)
    try protect(ready)
    lastStorageBytes = size
    return true
  }

  private func verifyReadyFile() throws -> Bool {
    let ready = readyURL()
    guard fileManager.fileExists(atPath: ready.path) else { return false }
    let size = (try fileManager.attributesOfItem(atPath: ready.path)[.size] as? NSNumber)?.int64Value ?? -1
    guard size == AlyteLocalModelManifest.bytes else { return false }
    return try hashFile(ready) == AlyteLocalModelManifest.sha256
  }

  private func hashFile(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let chunk = try handle.read(upToCount: 1024 * 1024) ?? Data()
      if chunk.isEmpty { break }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func protect(_ url: URL) throws {
    do {
      try fileManager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var mutable = url
      try mutable.setResourceValues(values)
      let result = try mutable.resourceValues(forKeys: [.isExcludedFromBackupKey])
      guard result.isExcludedFromBackup == true else { throw AlyteLocalModelError.failed(.storageProtection) }
    } catch let error as AlyteLocalModelError {
      throw error
    } catch {
      #if targetEnvironment(simulator) && DEBUG
      // The iOS simulator cannot provide device Data Protection. Debug fakes still verify backup
      // exclusion and never enable this fallback in preview/production builds.
      return
      #else
      throw AlyteLocalModelError.failed(.storageProtection)
      #endif
    }
  }

  private func removeIfPresent(_ url: URL) throws {
    guard !url.path.isEmpty, fileManager.fileExists(atPath: url.path) else { return }
    try fileManager.removeItem(at: url)
    guard !fileManager.fileExists(atPath: url.path) else { throw AlyteLocalModelError.failed(.runtimeFailed) }
  }

  private func releaseLoadedModel() {
    try? loadedHandle?.close()
    loadedHandle = nil
    if stateValue == "loaded" { setState("ready", failure: nil) }
  }

  private func fail(_ error: Error) {
    let value = (error as? AlyteLocalModelError)?.failure ?? .unknown
    failureValue = value
    stateValue = "failed"
    emitState()
  }

  private func setState(_ value: String, failure: AlyteLocalModelFailure?) {
    stateValue = value
    failureValue = failure
    emitState()
  }

  private func emitState() {
    stateObserver?(stateDictionary())
  }

  private func stateDictionary() -> [String: Any] {
    [
      "packId": AlyteLocalModelManifest.packID,
      "state": stateValue,
      "bytesReceived": bytesReceived,
      "expectedBytes": AlyteLocalModelManifest.bytes,
      "failure": failureValue?.rawValue ?? NSNull(),
      "storageBytes": lastStorageBytes,
      "loaded": stateValue == "loaded",
    ]
  }

  private func httpStatusFailure(_ response: URLResponse) -> AlyteLocalModelFailure {
    guard let status = (response as? HTTPURLResponse)?.statusCode else { return .httpFailed }
    return status == 404 || status == 410 ? .upstreamMissing : .httpFailed
  }

  private func networkFailure(_ error: Error) -> AlyteLocalModelFailure {
    let code = (error as NSError).code
    return code == NSURLErrorNotConnectedToInternet || code == NSURLErrorNetworkConnectionLost ? .offline : .httpFailed
  }
}
