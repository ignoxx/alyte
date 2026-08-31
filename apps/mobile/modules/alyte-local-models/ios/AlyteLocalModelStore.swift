import CryptoKit
import Foundation
import UIKit

/// UIKit and URLSession adapters around the transport-independent production lifecycle core.
final class AlyteLocalModelStore: NSObject, @unchecked Sendable, URLSessionDataDelegate, URLSessionTaskDelegate {
  typealias StateObserver = ([String: Any]) -> Void
  typealias RuntimeFactory = (URL, URL) throws -> any AlyteLocalModelRuntimeSession
  typealias AvailableMemory = () -> Int64
  typealias IdleTimerScheduler = AlyteLocalModelIdleTimerCoordinator.Schedule
  typealias IdleTimerReader = AlyteLocalModelIdleTimerCoordinator.ValueReader
  typealias IdleTimerWriter = AlyteLocalModelIdleTimerCoordinator.ValueWriter

  private let fileManager: FileManager
  private let queue = DispatchQueue(label: "com.alyte.local-models", qos: .utility)
  private let directory: URL
  private let modelCore: AlyteLocalModelCore
  private let projectorCore: AlyteLocalModelCore
  private let availableMemory: AvailableMemory
  private let idleTimerCoordinator: AlyteLocalModelIdleTimerCoordinator
  private var callbackGate = AlyteLocalModelDownloadCallbackGate()
  private var downloadOperation: DownloadOperation?
  private var packDownloadActive = false
  private var lastDownloadCancelled = false
  var stateObserver: StateObserver?

  private final class DownloadOperation {
    let identity: AlyteLocalModelDownloadOperationIdentity
    let session: URLSession
    let task: URLSessionDataTask
    let core: AlyteLocalModelCore
    let expectedURL: URL
    var downloadCompletion: ((Result<[String: Any], Error>) -> Void)?
    var cancelCompletions: [((Result<[String: Any], Error>) -> Void)] = []

    init(
      identity: AlyteLocalModelDownloadOperationIdentity,
      session: URLSession,
      task: URLSessionDataTask,
      core: AlyteLocalModelCore,
      expectedURL: URL,
      downloadCompletion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
      self.identity = identity
      self.session = session
      self.task = task
      self.core = core
      self.expectedURL = expectedURL
      self.downloadCompletion = downloadCompletion
    }
  }

  init(
    fileManager: FileManager = .default,
    runtimeFactory: @escaping RuntimeFactory = { modelURL, projectorURL in
      try AlytePinnedLlamaRuntimeSession(modelURL: modelURL, projectorURL: projectorURL)
    },
    availableMemory: @escaping AvailableMemory = {
      let available = alyte_local_model_runtime_available_memory()
      return available > UInt64(Int64.max) ? Int64.max : Int64(available)
    },
    idleTimerScheduler: @escaping IdleTimerScheduler = { block in
      if Thread.isMainThread {
        block()
      } else {
        DispatchQueue.main.async { block() }
      }
    },
    idleTimerReader: @escaping IdleTimerReader = { UIApplication.shared.isIdleTimerDisabled },
    idleTimerWriter: @escaping IdleTimerWriter = { UIApplication.shared.isIdleTimerDisabled = $0 }
  ) {
    self.fileManager = fileManager
    self.idleTimerCoordinator = AlyteLocalModelIdleTimerCoordinator(
      schedule: idleTimerScheduler,
      valueReader: idleTimerReader,
      valueWriter: idleTimerWriter
    )
    let directory = (try? fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ))?.appendingPathComponent("Alyte/Models", isDirectory: true) ?? URL(fileURLWithPath: "")
    self.directory = directory
    self.availableMemory = availableMemory
    let projectorURL = directory.appendingPathComponent(AlyteLocalModelManifest.projectorFilename)
    self.modelCore = AlyteLocalModelCore(
      directory: directory,
      expectedBytes: AlyteLocalModelManifest.artifactBytes,
      expectedDigest: AlyteLocalModelManifest.sha256,
      filename: AlyteLocalModelManifest.filename,
      allowedHosts: Set(AlyteLocalModelManifest.allowedHosts),
      fileManager: fileManager,
      hashFile: { try Self.hashFile(at: $0) },
      protectFile: { try Self.protect(fileManager: fileManager, at: $0) },
      availableMemory: availableMemory,
      enforcesProductionRequirements: false,
      runtimeFactory: { modelURL in try runtimeFactory(modelURL, projectorURL) }
    )
    self.projectorCore = AlyteLocalModelCore(
      directory: directory,
      expectedBytes: AlyteLocalModelManifest.projectorBytes,
      expectedDigest: AlyteLocalModelManifest.projectorSha256,
      filename: AlyteLocalModelManifest.projectorFilename,
      allowedHosts: Set(AlyteLocalModelManifest.allowedHosts),
      fileManager: fileManager,
      hashFile: { try Self.hashFile(at: $0) },
      protectFile: { try Self.protect(fileManager: fileManager, at: $0) },
      availableMemory: availableMemory,
      enforcesProductionRequirements: false,
      runtimeFactory: { _ in throw AlyteLocalModelRuntimeError.unavailable }
    )
    super.init()
    modelCore.stateObserver = { [weak self] _ in self?.handleStateChange() }
    projectorCore.stateObserver = { [weak self] _ in self?.handleStateChange() }
    queue.sync {
      modelCore.reconcileInstalledPack()
      projectorCore.reconcileInstalledPack()
    }
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
    idleTimerCoordinator.teardown()
    modelCore.requestInferenceCancellation()
    queue.sync { modelCore.releaseForPressure() }
    downloadOperation?.session.invalidateAndCancel()
  }

  func currentState() -> [String: Any] { queue.sync { packState() } }

  func startDownload(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          if self.downloadOperation != nil {
            continuation.resume(returning: self.packState())
            return
          }
          try self.admitPackDownloadCapacity()
          self.packDownloadActive = true
          self.lastDownloadCancelled = false
          self.continueDownload { result in continuation.resume(with: result) }
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          self.fail(localError)
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  private func continueDownload(completion: @escaping (Result<[String: Any], Error>) -> Void) {
    var targetCore: AlyteLocalModelCore?
    do {
      let target: (core: AlyteLocalModelCore, url: URL)?
      if !isReady(modelCore) {
        target = (modelCore, AlyteLocalModelManifest.expectedURL)
      } else if !isReady(projectorCore) {
        target = (projectorCore, AlyteLocalModelManifest.projectorExpectedURL)
      } else {
        packDownloadActive = false
        handleStateChange()
        completion(.success(packState()))
        return
      }
      guard let target else { return }
      targetCore = target.core
      switch try target.core.admitDownload() {
      case .ready:
        continueDownload(completion: completion)
      case .transfer(let offset):
        beginDownload(core: target.core, url: target.url, offset: offset, completion: completion)
      }
    } catch {
      let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
      packDownloadActive = false
      (targetCore ?? downloadOperation?.core ?? modelCore).markFailed(localError)
      handleStateChange()
      completion(.failure(localError))
    }
  }

  private func admitPackDownloadCapacity() throws {
    let capacity = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
      .volumeAvailableCapacityForImportantUsage ?? 0
    let retainedBytes = max(modelCore.storageBytes, modelCore.bytesReceived) +
      max(projectorCore.storageBytes, projectorCore.bytesReceived)
    guard capacity + retainedBytes >= AlyteLocalModelManifest.minimumFreeBytes else {
      throw AlyteLocalModelError.failed(.insufficientSpace)
    }
  }

  private func isReady(_ core: AlyteLocalModelCore) -> Bool {
    core.state == .ready || core.state == .loaded
  }

  func cancelDownload() async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard let operation = self.downloadOperation else {
          continuation.resume(returning: self.packState())
          return
        }
        operation.core.requestCancellation()
        operation.cancelCompletions.append { [weak self] result in
          guard let self else { return }
          switch result {
          case .success(let state): continuation.resume(returning: state)
          case .failure:
            operation.core.reconcileInstalledPack()
            continuation.resume(returning: self.packState())
          }
        }
        operation.task.cancel()
      }
    }
  }

  func load(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          guard ProcessInfo.processInfo.physicalMemory >= AlyteLocalModelManifest.minimumMemoryBytes,
            self.availableMemory() >= AlyteLocalModelManifest.minimumMemoryBytes
          else { throw AlyteLocalModelError.failed(.incompatible) }
          try self.projectorCore.requireVerifiedForActivation()
          _ = try self.modelCore.activateVerifiedPack()
          continuation.resume(returning: self.packState())
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  func infer(prompt: String, maxOutputTokens: Int, outputCapacity: Int) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          continuation.resume(
            returning: try self.modelCore.infer(
              prompt: prompt,
              maxOutputTokens: maxOutputTokens,
              outputCapacity: outputCapacity
            )
          )
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  func inferImage(
    prompt: String,
    imageURL: URL,
    maxOutputTokens: Int,
    outputCapacity: Int
  ) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          let standardizedURL = imageURL.standardizedFileURL
          let sandboxURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
          guard standardizedURL.isFileURL,
            standardizedURL.path.hasPrefix(sandboxURL.path + "/"),
            let fileSize = try standardizedURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
            fileSize > 0,
            fileSize <= 16 * 1024 * 1024
          else { throw AlyteLocalModelError.failed(.runtimeFailed) }
          let imageData = try Data(contentsOf: standardizedURL, options: [.mappedIfSafe])
          continuation.resume(
            returning: try self.modelCore.inferImage(
              prompt: prompt,
              imageData: imageData,
              maxOutputTokens: maxOutputTokens,
              outputCapacity: outputCapacity
            )
          )
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  /// Direct atomic signal; unlike unload/release it never waits behind an in-flight inference.
  func cancelInference() {
    modelCore.requestInferenceCancellation()
  }

  func unload() -> [String: Any] {
    queue.sync {
      _ = modelCore.unload()
      return packState()
    }
  }

  func deletePack(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        let operation = self.downloadOperation
        let operationSession = operation?.session
        let operationTask = operation?.task
        // Invalidate before asking URLSession to cancel. The cancellation callback is allowed to
        // arrive after a replacement transfer starts, but it no longer matches this gate.
        if let operation {
          self.invalidate(operation, teardownSession: false)
        }
        operation?.core.requestCancellation()
        operationTask?.cancel()
        do {
          self.packDownloadActive = false
          self.lastDownloadCancelled = false
          var firstError: Error?
          do { _ = try self.modelCore.delete() } catch { firstError = error }
          do { _ = try self.projectorCore.delete() } catch { if firstError == nil { firstError = error } }
          if let firstError { throw firstError }
          let state = self.packState()
          self.resolve(
            operation,
            download: .failure(AlyteLocalModelError.failed(.cancelled)),
            cancellation: .success(state)
          )
          operationSession?.invalidateAndCancel()
          continuation.resume(returning: state)
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          self.fail(localError)
          self.resolve(
            operation,
            download: .failure(localError),
            cancellation: .failure(localError)
          )
          operationSession?.invalidateAndCancel()
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  func releaseForBackground() {
    // Pressure callbacks can arrive while the serialized inference job is decoding. Signal the
    // C loop first, then let the queue close the runtime after that job returns.
    modelCore.requestInferenceCancellation()
    queue.async { self.modelCore.releaseForPressure() }
  }

  func applicationDidEnterBackground() {
    idleTimerCoordinator.setApplicationIsForeground(false)
    releaseForBackground()
  }

  func applicationDidEnterForeground() {
    idleTimerCoordinator.setApplicationIsForeground(true)
  }

  @objc private func memoryWarning() { releaseForBackground() }

  @objc private func thermalStateChanged() {
    if ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical {
      releaseForBackground()
    }
  }

  private func beginDownload(
    core: AlyteLocalModelCore,
    url: URL,
    offset: Int64,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    var request = URLRequest(url: url)
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
    let urlSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    let task = urlSession.dataTask(with: request)
    let identity = callbackGate.begin(session: urlSession, task: task)
    let operation = DownloadOperation(
      identity: identity,
      session: urlSession,
      task: task,
      core: core,
      expectedURL: url,
      downloadCompletion: completion
    )
    downloadOperation = operation
    task.resume()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    queue.sync {
      guard self.callbackGate.accepts(session: session, task: task) else {
        completionHandler(nil)
        return
      }
      do {
        guard let operation = self.downloadOperation else {
          throw AlyteLocalModelError.failed(.interrupted)
        }
        try operation.core.acceptRedirect(request.url ?? URL(fileURLWithPath: ""))
        var next = request
        next.setValue(nil, forHTTPHeaderField: "Authorization")
        next.setValue(nil, forHTTPHeaderField: "Cookie")
        completionHandler(next)
      } catch {
        completionHandler(nil)
      }
      _ = response
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    queue.sync {
      guard self.callbackGate.accepts(session: session, task: dataTask) else {
        completionHandler(.cancel)
        return
      }
      do {
        guard let http = response as? HTTPURLResponse else { throw AlyteLocalModelError.failed(.httpFailed) }
        guard let operation = self.downloadOperation else {
          throw AlyteLocalModelError.failed(.interrupted)
        }
        try operation.core.acceptResponse(
          status: http.statusCode,
          contentRange: http.value(forHTTPHeaderField: "Content-Range"),
          url: http.url ?? operation.expectedURL
        )
        completionHandler(.allow)
      } catch {
        completionHandler(.cancel)
      }
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    queue.async {
      guard self.callbackGate.accepts(session: session, task: dataTask) else { return }
      do {
        guard let operation = self.downloadOperation else {
          throw AlyteLocalModelError.failed(.interrupted)
        }
        try operation.core.append(data)
      } catch {
        dataTask.cancel()
      }
    }
    _ = session
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    queue.async {
      guard let operation = self.currentOperation(session: session, task: task) else { return }
      self.invalidate(operation, teardownSession: false)
      let transportFailure = error.map { self.networkFailure($0) }
      switch operation.core.complete(transportFailure: transportFailure) {
      case .succeeded:
        let completion = operation.downloadCompletion
        operation.downloadCompletion = nil
        operation.session.invalidateAndCancel()
        if let completion { self.continueDownload(completion: completion) }
      case .cancelled:
        self.packDownloadActive = false
        self.lastDownloadCancelled = true
        let state = self.packState()
        self.handleStateChange()
        self.resolve(
          operation,
          download: .failure(AlyteLocalModelError.failed(.cancelled)),
          cancellation: .success(state)
        )
      case .failed(let localError):
        self.packDownloadActive = false
        self.lastDownloadCancelled = false
        self.handleStateChange()
        self.resolve(operation, download: .failure(localError), cancellation: .failure(localError))
      }
      operation.session.invalidateAndCancel()
    }
  }

  private func currentOperation(session: URLSession, task: URLSessionTask) -> DownloadOperation? {
    guard let operation = downloadOperation,
      callbackGate.accepts(session: session, task: task)
    else { return nil }
    return operation
  }

  private func invalidate(_ operation: DownloadOperation, teardownSession: Bool = true) {
    callbackGate.invalidate(operation.identity)
    if teardownSession { operation.session.invalidateAndCancel() }
    if downloadOperation === operation { downloadOperation = nil }
  }

  private func resolve(
    _ operation: DownloadOperation?,
    download: Result<[String: Any], Error>,
    cancellation: Result<[String: Any], Error>
  ) {
    guard let operation else { return }
    let downloadCompletion = operation.downloadCompletion
    operation.downloadCompletion = nil
    let cancelCompletions = operation.cancelCompletions
    operation.cancelCompletions.removeAll()
    downloadCompletion?(download)
    cancelCompletions.forEach { $0(cancellation) }
  }

  private func fail(_ error: AlyteLocalModelError) {
    (downloadOperation?.core ?? modelCore).markFailed(error)
  }

  private func handleStateChange() {
    let state = packState()
    if let rawState = state["state"] as? String, let value = AlyteLocalModelState(rawValue: rawState) {
      idleTimerCoordinator.stateChanged(value)
    }
    stateObserver?(state)
  }

  private func packState() -> [String: Any] {
    let bytesReceived = modelCore.bytesReceived + projectorCore.bytesReceived
    let storageBytes = modelCore.storageBytes + projectorCore.storageBytes
    let state: AlyteLocalModelState
    let failure: AlyteLocalModelFailure?
    if modelCore.state == .loaded && isReady(projectorCore) {
      state = .loaded
      failure = nil
    } else if let operation = downloadOperation,
      operation.core.state == .downloading || operation.core.state == .verifying || operation.core.state == .cancelling
    {
      state = operation.core.state
      failure = operation.core.failure
    } else if isReady(modelCore) && isReady(projectorCore) {
      state = .ready
      failure = nil
    } else if packDownloadActive {
      state = .downloading
      failure = nil
    } else if modelCore.failure != nil || projectorCore.failure != nil {
      state = .failed
      failure = modelCore.failure ?? projectorCore.failure
    } else if lastDownloadCancelled {
      state = .notInstalled
      failure = nil
    } else if bytesReceived > 0 || storageBytes > 0 {
      state = .failed
      failure = .interrupted
    } else {
      state = .notInstalled
      failure = nil
    }
    return AlyteLocalModelSnapshot(
      state: state,
      bytesReceived: bytesReceived,
      storageBytes: storageBytes,
      failure: failure
    ).dictionary
  }

  private func networkFailure(_ error: Error) -> AlyteLocalModelFailure {
    let code = (error as NSError).code
    return code == NSURLErrorCancelled ? .cancelled :
      (code == NSURLErrorNotConnectedToInternet || code == NSURLErrorNetworkConnectionLost ? .offline : .httpFailed)
  }

  private static func hashFile(at url: URL) throws -> String {
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

  private static func protect(fileManager: FileManager, at url: URL) throws {
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
      throw AlyteLocalModelError.failed(.storageProtection)
    }
  }
}
