import Foundation

protocol AlyteLocalModelRuntimeSession: AnyObject {
  func close()
}

enum AlyteLocalModelRuntimeError: Error {
  case unavailable
  case loadFailed
}

/// Owns one real llama.cpp model/context pair when the externally built, pinned XCFramework is
/// linked. The no-runtime implementation is intentionally unavailable rather than a file proxy;
/// simulator UI tests inject a synthetic session at the store seam and never enable this path.
final class AlytePinnedLlamaRuntimeSession: AlyteLocalModelRuntimeSession, @unchecked Sendable {
  private var runtime: UnsafeMutableRawPointer?

  init(modelURL: URL) throws {
    let created = modelURL.path.withCString { path in
      alyte_local_model_runtime_create(path)
    }
    guard let created else {
      #if ALYTE_LLAMA_RUNTIME
      throw AlyteLocalModelRuntimeError.loadFailed
      #else
      throw AlyteLocalModelRuntimeError.unavailable
      #endif
    }
    runtime = created
  }

  func close() {
    guard let runtime else { return }
    alyte_local_model_runtime_destroy(runtime)
    self.runtime = nil
  }

  deinit {
    close()
  }
}
