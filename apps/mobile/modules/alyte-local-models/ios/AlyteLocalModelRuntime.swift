import Foundation

/// Owns one real llama.cpp model/context pair when the externally built, pinned XCFramework is
/// linked. The no-runtime implementation is intentionally unavailable rather than a file proxy;
/// simulator UI tests inject a synthetic session at the store seam and never enable this path.
final class AlytePinnedLlamaRuntimeSession: AlyteLocalModelRuntimeSession, @unchecked Sendable {
  private var runtime: UnsafeMutableRawPointer?

  init(modelURL: URL, projectorURL: URL) throws {
    var failureStage: Int32 = 0
    let created = modelURL.path.withCString { modelPath in
      projectorURL.path.withCString { projectorPath in
        AlyteDocumentVLMGrammar.root.withCString { grammarText in
          "root".withCString { root in
            alyte_local_model_runtime_create(
              modelPath,
              projectorPath,
              grammarText,
              root,
              &failureStage
            )
          }
        }
      }
    }
    guard let created else {
      #if ALYTE_LLAMA_RUNTIME
      throw AlyteLocalModelRuntimeError.loadFailed(
        AlyteLocalModelRuntimeFailureStage(rawValueFromNative: failureStage))
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

  func cancelInference() {
    if let runtime { alyte_local_model_runtime_cancel(runtime) }
  }

  func generate(prompt: String, maxOutputTokens: Int, outputCapacity: Int) throws -> String {
    guard let runtime else { throw AlyteLocalModelRuntimeError.unavailable }
    var output = [CChar](repeating: 0, count: outputCapacity)
    let count = prompt.withCString { promptText in
      output.withUnsafeMutableBufferPointer { buffer in
        alyte_local_model_runtime_generate(
          runtime,
          promptText,
          Int32(maxOutputTokens),
          buffer.baseAddress,
          outputCapacity
        )
      }
    }
    guard count >= 0 else {
      switch count {
      case -2: throw AlyteLocalModelRuntimeError.loadFailed(.unknown)
      case -3: throw AlyteLocalModelRuntimeError.loadFailed(.unknown)
      case -7: throw AlyteLocalModelRuntimeError.cancelled
      default: throw AlyteLocalModelRuntimeError.loadFailed(.unknown)
      }
    }
    return String(decoding: output.prefix(Int(count)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  func generateImage(
    prompt: String,
    imageData: Data,
    maxOutputTokens: Int,
    outputCapacity: Int
  ) throws -> String {
    guard let runtime else { throw AlyteLocalModelRuntimeError.unavailable }
    var output = [CChar](repeating: 0, count: outputCapacity)
    let count = prompt.withCString { promptText in
      imageData.withUnsafeBytes { imageBuffer in
        output.withUnsafeMutableBufferPointer { outputBuffer in
          alyte_local_model_runtime_generate_image(
            runtime,
            promptText,
            imageBuffer.bindMemory(to: UInt8.self).baseAddress,
            imageData.count,
            Int32(maxOutputTokens),
            outputBuffer.baseAddress,
            outputCapacity
          )
        }
      }
    }
    guard count >= 0 else {
      if count == -7 { throw AlyteLocalModelRuntimeError.cancelled }
      throw AlyteLocalModelRuntimeError.loadFailed(.unknown)
    }
    return String(decoding: output.prefix(Int(count)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  deinit {
    close()
  }
}
