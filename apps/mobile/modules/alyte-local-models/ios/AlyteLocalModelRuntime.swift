import Foundation

/// Owns one real llama.cpp model/context pair when the externally built, pinned XCFramework is
/// linked. The no-runtime implementation is intentionally unavailable rather than a file proxy;
/// simulator UI tests inject a synthetic session at the store seam and never enable this path.
final class AlytePinnedLlamaRuntimeSession: AlyteLocalModelRuntimeSession, @unchecked Sendable {
  private var runtime: UnsafeMutableRawPointer?

  init(modelURL: URL) throws {
    let grammar = #"""
      root ::= "{" ws "\"schemaVersion\"" ws ":" ws "\"alyte.semantic-mapper.v1\"" ws "," ws "\"proposals\"" ws ":" ws proposals ws "}"
      proposals ::= "[" ws (proposal (ws "," ws proposal)*)? ws "]"
      proposal ::= "{" ws "\"sourceObservationIds\"" ws ":" ws stringList ws "," ws "\"role\"" ws ":" ws role ws "," ws "\"specimenType\"" ws ":" ws specimen ws "," ws "\"biomarkerId\"" ws ":" ws (string | "null") ws "}"
      stringList ::= "[" ws string (ws "," ws string)* ws "]"
      role ::= "\"measurement\"" | "\"specimen-context\"" | "\"ignore\""
      specimen ::= "\"blood\"" | "\"serum\"" | "\"plasma\"" | "\"urine\"" | "\"other\"" | "\"unknown\""
      string ::= "\"" ([^"\\] | escape)* "\""
      escape ::= "\\" (["\\/bfnrt] | "u" hex4)
      hex4 ::= [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]
      ws ::= [ \t\n\r]*
      """#
    let created = modelURL.path.withCString { path in
      grammar.withCString { grammarText in
        "root".withCString { root in
          alyte_local_model_runtime_create(path, grammarText, root)
        }
      }
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
      case -2: throw AlyteLocalModelRuntimeError.loadFailed
      case -3: throw AlyteLocalModelRuntimeError.loadFailed
      default: throw AlyteLocalModelRuntimeError.loadFailed
      }
    }
    return String(decoding: output.prefix(Int(count)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
  }

  deinit {
    close()
  }
}
