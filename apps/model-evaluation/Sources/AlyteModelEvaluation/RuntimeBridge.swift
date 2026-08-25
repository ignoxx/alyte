import Foundation

/// Evaluation-only owner of one in-memory llama.cpp session.
///
/// The Xcode target enables `ALYTE_LLAMA_EVAL` only when the operator has supplied the externally
/// built pinned XCFramework. Swift Package Manager and ordinary repository builds retain a safe
/// unavailable implementation, so production Alyte never links this runtime. Generated text is
/// returned to the caller for immediate validation and is not written by this type.
public enum LlamaCppRuntimeBridge {
    public static var isFrameworkLinked: Bool {
        #if ALYTE_LLAMA_EVAL
        return true
        #else
        return false
        #endif
    }
}

public enum LlamaCppRuntimeError: Error, Equatable, Sendable {
    case unavailable
    case modelLoadFailed
    case inferenceFailed
    case outputLimitExceeded
}

public final class LlamaCppRuntimeSession: @unchecked Sendable {
    #if ALYTE_LLAMA_EVAL
    private var session: UnsafeMutableRawPointer?
    #endif

    public init(
        modelURL: URL,
        grammar: String,
        grammarRoot: String,
        contextTokens: Int,
        batchTokens: Int,
        threads: Int
    ) throws {
        #if ALYTE_LLAMA_EVAL
        let created = modelURL.path.withCString { modelPath in
            grammar.withCString { grammarText in
                grammarRoot.withCString { root in
                    alyte_llama_session_create(
                        modelPath,
                        grammarText,
                        root,
                        Int32(contextTokens),
                        Int32(batchTokens),
                        Int32(threads)
                    )
                }
            }
        }
        guard let created else { throw LlamaCppRuntimeError.modelLoadFailed }
        self.session = created
        #else
        _ = modelURL
        _ = grammar
        _ = grammarRoot
        _ = contextTokens
        _ = batchTokens
        _ = threads
        throw LlamaCppRuntimeError.unavailable
        #endif
    }

    deinit {
        #if ALYTE_LLAMA_EVAL
        if let session { alyte_llama_session_destroy(session) }
        #endif
    }

    public func generate(
        prompt: String,
        maxOutputTokens: Int,
        outputCapacity: Int = 16_384
    ) throws -> String {
        #if ALYTE_LLAMA_EVAL
        guard let session else { throw LlamaCppRuntimeError.inferenceFailed }
        guard outputCapacity > 0 else { throw LlamaCppRuntimeError.outputLimitExceeded }
        var output = [CChar](repeating: 0, count: outputCapacity)
        let result = prompt.withCString { promptText in
            output.withUnsafeMutableBufferPointer { buffer in
                alyte_llama_session_generate(
                    session,
                    promptText,
                    Int32(maxOutputTokens),
                    buffer.baseAddress,
                    outputCapacity
                )
            }
        }
        switch result {
        case 0...:
            let bytes = output.prefix(Int(result)).map { UInt8(bitPattern: $0) }
            return String(decoding: bytes, as: UTF8.self)
        case -2:
            throw LlamaCppRuntimeError.outputLimitExceeded
        default:
            throw LlamaCppRuntimeError.inferenceFailed
        }
        #else
        _ = prompt
        _ = maxOutputTokens
        _ = outputCapacity
        throw LlamaCppRuntimeError.unavailable
        #endif
    }
}
