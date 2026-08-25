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

enum AlyteLocalModelError: Error {
  case unsupportedPack
  case invalidManifest
  case unavailable(AlyteLocalModelFailure)
  case failed(AlyteLocalModelFailure)

  var failure: AlyteLocalModelFailure {
    switch self {
    case .unsupportedPack, .invalidManifest: return .incompatible
    case .unavailable(let value), .failed(let value): return value
    }
  }
}
