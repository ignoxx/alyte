import Foundation

enum AlyteLocalModelState: String {
  case notInstalled = "not-installed"
  case downloading
  case verifying
  case ready
  case loaded
  case failed
  case cancelling
  case deleting
}

/// Pure lifecycle policy for the iOS idle timer. A model transfer is deliberately a foreground
/// concern: only its active download and verification states keep the screen awake, and app
/// backgrounding always wins over the model state until the app returns to the foreground.
struct AlyteLocalModelIdleTimerPolicy {
  private(set) var state: AlyteLocalModelState = .notInstalled
  private(set) var isForeground = true

  var shouldDisableIdleTimer: Bool {
    isForeground && (state == .downloading || state == .verifying)
  }

  @discardableResult
  mutating func setState(_ value: AlyteLocalModelState) -> Bool {
    state = value
    return shouldDisableIdleTimer
  }

  @discardableResult
  mutating func setApplicationIsForeground(_ value: Bool) -> Bool {
    isForeground = value
    return shouldDisableIdleTimer
  }
}

/// Serializes idle-timer ownership and the UIKit read/write pair on the main thread. State
/// callbacks can arrive from URLSession's queue, so each request carries a generation. A queued
/// enable is ignored once a newer background or teardown request has claimed the generation.
final class AlyteLocalModelIdleTimerCoordinator {
  typealias Schedule = (@escaping () -> Void) -> Void
  typealias ValueReader = () -> Bool
  typealias ValueWriter = (Bool) -> Void

  private let schedule: Schedule
  private let valueReader: ValueReader
  private let valueWriter: ValueWriter
  private let generationLock = NSLock()
  private var generation: UInt = 0
  private var teardownRequested = false
  private var latestState = AlyteLocalModelState.notInstalled
  private var latestIsForeground = true

  // Policy and ownership are only touched by scheduled coordinator blocks. Inbound callbacks
  // update latestState and generation under generationLock before scheduling those blocks.
  private var policy = AlyteLocalModelIdleTimerPolicy()
  private var priorValue: Bool?
  private var ownsIdleTimer = false
  private var isTornDown = false

  init(schedule: @escaping Schedule, valueReader: @escaping ValueReader, valueWriter: @escaping ValueWriter) {
    self.schedule = schedule
    self.valueReader = valueReader
    self.valueWriter = valueWriter
  }

  func stateChanged(_ state: AlyteLocalModelState) {
    guard let token = issueStateToken(state) else { return }
    schedule { [self] in
      guard isCurrent(token), !isTornDown else { return }
      _ = policy.setApplicationIsForeground(latestForegroundValue())
      _ = policy.setState(state)
      applyDesiredValue()
    }
  }

  func setApplicationIsForeground(_ isForeground: Bool) {
    guard let token = issueForegroundToken(isForeground) else { return }
    schedule { [self] in
      guard isCurrent(token), !isTornDown else { return }
      _ = policy.setApplicationIsForeground(latestForegroundValue())
      _ = policy.setState(latestStateValue())
      applyDesiredValue()
    }
  }

  func teardown() {
    guard let token = issueTeardownToken() else { return }
    // Capture self strongly: Store teardown may release its last reference before an off-main
    // lifecycle callback reaches the main queue, but ownership must still be restored.
    schedule { [self] in
      guard isCurrent(token), !isTornDown else { return }
      _ = policy.setApplicationIsForeground(false)
      restorePriorValue()
      isTornDown = true
    }
  }

  private func applyDesiredValue() {
    if policy.shouldDisableIdleTimer {
      guard !ownsIdleTimer else { return }
      let prior = valueReader()
      priorValue = prior
      ownsIdleTimer = true
      if !prior { valueWriter(true) }
      return
    }

    restorePriorValue()
  }

  private func restorePriorValue() {
    guard ownsIdleTimer else { return }
    let prior = priorValue ?? false
    if valueReader() != prior { valueWriter(prior) }
    priorValue = nil
    ownsIdleTimer = false
  }

  private func issueStateToken(_ state: AlyteLocalModelState) -> UInt? {
    generationLock.lock()
    defer { generationLock.unlock() }
    guard !teardownRequested else { return nil }
    latestState = state
    generation &+= 1
    return generation
  }

  private func issueForegroundToken(_ isForeground: Bool) -> UInt? {
    generationLock.lock()
    defer { generationLock.unlock() }
    guard !teardownRequested else { return nil }
    latestIsForeground = isForeground
    generation &+= 1
    return generation
  }

  private func latestStateValue() -> AlyteLocalModelState {
    generationLock.lock()
    defer { generationLock.unlock() }
    return latestState
  }

  private func latestForegroundValue() -> Bool {
    generationLock.lock()
    defer { generationLock.unlock() }
    return latestIsForeground
  }

  private func issueTeardownToken() -> UInt? {
    generationLock.lock()
    defer { generationLock.unlock() }
    guard !teardownRequested else { return nil }
    teardownRequested = true
    generation &+= 1
    return generation
  }

  private func isCurrent(_ token: UInt) -> Bool {
    generationLock.lock()
    defer { generationLock.unlock() }
    return generation == token
  }
}

struct AlyteLocalModelSnapshot {
  let state: AlyteLocalModelState
  let bytesReceived: Int64
  let storageBytes: Int64
  let failure: AlyteLocalModelFailure?

  var dictionary: [String: Any] {
    [
      "packId": AlyteLocalModelManifest.packID,
      "state": state.rawValue,
      "bytesReceived": bytesReceived,
      "expectedBytes": AlyteLocalModelManifest.bytes,
      "failure": failure?.rawValue ?? NSNull(),
      "storageBytes": storageBytes,
      "loaded": state == .loaded,
    ]
  }
}

enum AlyteLocalModelFailure: String {
  case offline = "offline"
  case insufficientSpace = "insufficient-space"
  case upstreamMissing = "upstream-missing"
  case httpFailed = "http-failed"
  case redirectRejected = "redirect-rejected"
  case rangeRejected = "range-rejected"
  case sizeMismatch = "size-mismatch"
  case checksumMismatch = "checksum-mismatch"
  case incompatible = "incompatible"
  case cancelled = "cancelled"
  case unavailable = "unavailable"
  case runtimeFailed = "runtime-failed"
  case storageProtection = "storage-protection"
  case interrupted = "interrupted"
  case unknown = "unknown"
}

/// Release-safe stage from the native runtime creation boundary. It intentionally carries no
/// path, prompt, model, or health data; release-facing errors continue to use runtime-failed.
enum AlyteLocalModelRuntimeFailureStage: String {
  case modelLoad = "model-load"
  case context
  case grammar
  case sampler
  case allocation
  case unknown

  init(rawValueFromNative value: Int32) {
    switch value {
    case 1: self = .modelLoad
    case 2: self = .context
    case 3: self = .grammar
    case 4: self = .sampler
    case 5: self = .allocation
    default: self = .unknown
    }
  }
}

enum AlyteLocalModelError: Error {
  case unsupportedPack
  case invalidManifest
  case unavailable(AlyteLocalModelFailure)
  case failed(AlyteLocalModelFailure)
  case runtimeFailed(AlyteLocalModelRuntimeFailureStage)

  var failure: AlyteLocalModelFailure {
    switch self {
    case .unsupportedPack, .invalidManifest: return .incompatible
    case .unavailable(let value), .failed(let value): return value
    case .runtimeFailed: return .runtimeFailed
    }
  }

  var runtimeFailureStage: AlyteLocalModelRuntimeFailureStage? {
    switch self {
    case .runtimeFailed(let stage): return stage
    default: return nil
    }
  }
}
