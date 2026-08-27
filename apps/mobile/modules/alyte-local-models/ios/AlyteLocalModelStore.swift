import CryptoKit
import Foundation
import UIKit

/// UIKit and URLSession adapters around the transport-independent production lifecycle core.
final class AlyteLocalModelStore: NSObject, @unchecked Sendable, URLSessionDataDelegate, URLSessionTaskDelegate {
  typealias StateObserver = ([String: Any]) -> Void
  typealias RuntimeFactory = (URL) throws -> any AlyteLocalModelRuntimeSession
  typealias IdleTimerScheduler = AlyteLocalModelIdleTimerCoordinator.Schedule
  typealias IdleTimerReader = AlyteLocalModelIdleTimerCoordinator.ValueReader
  typealias IdleTimerWriter = AlyteLocalModelIdleTimerCoordinator.ValueWriter

  private let fileManager: FileManager
  private let queue = DispatchQueue(label: "com.alyte.local-models", qos: .utility)
  private let core: AlyteLocalModelCore
  private let idleTimerCoordinator: AlyteLocalModelIdleTimerCoordinator
  private var callbackGate = AlyteLocalModelDownloadCallbackGate()
  private var downloadOperation: DownloadOperation?
  var stateObserver: StateObserver?

  private final class DownloadOperation {
    let identity: AlyteLocalModelDownloadOperationIdentity
    let session: URLSession
    let task: URLSessionDataTask
    var downloadCompletion: ((Result<[String: Any], Error>) -> Void)?
    var cancelCompletions: [((Result<[String: Any], Error>) -> Void)] = []

    init(
      identity: AlyteLocalModelDownloadOperationIdentity,
      session: URLSession,
      task: URLSessionDataTask,
      downloadCompletion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
      self.identity = identity
      self.session = session
      self.task = task
      self.downloadCompletion = downloadCompletion
    }
  }

  init(
    fileManager: FileManager = .default,
    runtimeFactory: @escaping RuntimeFactory = { url in try AlytePinnedLlamaRuntimeSession(modelURL: url) },
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
    self.core = AlyteLocalModelCore(
      directory: directory,
      expectedBytes: AlyteLocalModelManifest.bytes,
      expectedDigest: AlyteLocalModelManifest.sha256,
      filename: AlyteLocalModelManifest.filename,
      allowedHosts: Set(AlyteLocalModelManifest.allowedHosts),
      fileManager: fileManager,
      hashFile: { try Self.hashFile(at: $0) },
      protectFile: { try Self.protect(fileManager: fileManager, at: $0) },
      availableMemory: {
        let available = alyte_local_model_runtime_available_memory()
        return available > UInt64(Int64.max) ? Int64.max : Int64(available)
      },
      runtimeFactory: runtimeFactory
    )
    super.init()
    core.stateObserver = { [weak self] state in self?.handleStateChange(state) }
    queue.sync { core.reconcileInstalledPack() }
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
    core.requestInferenceCancellation()
    queue.sync { core.releaseForPressure() }
    downloadOperation?.session.invalidateAndCancel()
  }

  func currentState() -> [String: Any] { queue.sync { core.currentState() } }

  func startDownload(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          if self.downloadOperation != nil {
            continuation.resume(returning: self.core.currentState())
            return
          }
          switch try self.core.admitDownload() {
          case .ready(let state):
            continuation.resume(returning: state)
          case .transfer(let offset):
            self.beginDownload(offset: offset) { result in continuation.resume(with: result) }
          }
        } catch {
          let localError = (error as? AlyteLocalModelError) ?? AlyteLocalModelError.failed(.runtimeFailed)
          self.fail(localError)
          continuation.resume(throwing: localError)
        }
      }
    }
  }

  func cancelDownload() async throws -> [String: Any] {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        guard let operation = self.downloadOperation else {
          continuation.resume(returning: self.core.currentState())
          return
        }
        self.core.requestCancellation()
        operation.cancelCompletions.append { [weak self] result in
          guard let self else { return }
          switch result {
          case .success(let state): continuation.resume(returning: state)
          case .failure:
            self.core.reconcileInstalledPack()
            continuation.resume(returning: self.core.currentState())
          }
        }
        operation.task?.cancel()
      }
    }
  }

  func load(packID: String) async throws -> [String: Any] {
    guard packID == AlyteLocalModelManifest.packID else { throw AlyteLocalModelError.unsupportedPack }
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          continuation.resume(returning: try self.core.activateVerifiedPack())
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
            returning: try self.core.infer(
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

  /// Direct atomic signal; unlike unload/release it never waits behind an in-flight inference.
  func cancelInference() {
    core.requestInferenceCancellation()
  }

  func unload() -> [String: Any] { queue.sync { core.unload() } }

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
        self.core.requestCancellation()
        operationTask?.cancel()
        do {
          let state = try self.core.delete()
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
    core.requestInferenceCancellation()
    queue.async { self.core.releaseForPressure() }
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

  private func beginDownload(offset: Int64, completion: @escaping (Result<[String: Any], Error>) -> Void) {
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
    let urlSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    let task = urlSession.dataTask(with: request)
    let identity = callbackGate.begin(session: urlSession, task: task)
    let operation = DownloadOperation(
      identity: identity,
      session: urlSession,
      task: task,
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
        try self.core.acceptRedirect(request.url ?? URL(fileURLWithPath: ""))
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
        try self.core.acceptResponse(
          status: http.statusCode,
          contentRange: http.value(forHTTPHeaderField: "Content-Range"),
          url: http.url ?? AlyteLocalModelManifest.expectedURL
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
        try self.core.append(data)
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
      switch self.core.complete(transportFailure: transportFailure) {
      case .succeeded(let state):
        self.resolve(operation, download: .success(state), cancellation: .success(state))
      case .cancelled(let state):
        self.resolve(
          operation,
          download: .failure(AlyteLocalModelError.failed(.cancelled)),
          cancellation: .success(state)
        )
      case .failed(let localError):
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
    core.markFailed(error)
  }

  private func handleStateChange(_ state: [String: Any]) {
    if let rawState = state["state"] as? String, let value = AlyteLocalModelState(rawValue: rawState) {
      idleTimerCoordinator.stateChanged(value)
    }
    stateObserver?(state)
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
