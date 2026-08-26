import ExpoModulesCore
import Foundation
import os

public final class AlyteLocalModelsModule: Module {
  private static let activationLogger = Logger(subsystem: "com.alyte.local-models", category: "activation")
  private var store: AlyteLocalModelStore!

  public func definition() -> ModuleDefinition {
    Name("AlyteLocalModels")
    Events("stateChanged")

    OnCreate {
      self.store = AlyteLocalModelStore()
      self.store.stateObserver = { [weak self] state in
        self?.sendEvent("stateChanged", state)
      }
    }
    OnDestroy {
      self.store = nil
    }
    OnAppEntersBackground {
      self.store.applicationDidEnterBackground()
    }
    OnAppEntersForeground {
      self.store.applicationDidEnterForeground()
      // A verified ready pack remains on disk. The runtime is deliberately loaded only when an
      // extraction requests it, so relaunch/background never pins a multi-gigabyte allocation.
    }

    Function("getManifest") {
      AlyteLocalModelManifest.publicManifest()
    }

    Function("getState") {
      self.store.currentState()
    }

    AsyncFunction("startDownload") { (packID: String) async throws -> [String: Any] in
      do { return try await self.store.startDownload(packID: packID) }
      catch { throw Self.nativeError(error, message: "The local model could not be downloaded", code: 1) }
    }

    AsyncFunction("cancelDownload") { () async throws -> [String: Any] in
      do { return try await self.store.cancelDownload() }
      catch { throw Self.nativeError(error, message: "The local model download could not be cancelled", code: 2) }
    }

    AsyncFunction("load") { (packID: String) async throws -> [String: Any] in
      do { return try await self.store.load(packID: packID) }
      catch { throw Self.nativeError(error, message: "The local model could not be loaded", code: 3) }
    }

    AsyncFunction("infer") { (prompt: String, maxOutputTokens: Int, outputCapacity: Int) async throws -> String in
      do {
        return try await self.store.infer(
          prompt: prompt,
          maxOutputTokens: maxOutputTokens,
          outputCapacity: outputCapacity
        )
      } catch {
        throw Self.nativeError(error, message: "The local semantic mapping could not finish", code: 5)
      }
    }

    // This is deliberately synchronous/non-queueing: JS timeouts and OS pressure must reach the
    // native generation loop while the serialized infer task is still running.
    Function("cancelInference") {
      self.store.cancelInference()
    }

    Function("unload") {
      self.store.unload()
    }

    AsyncFunction("deletePack") { (packID: String) async throws -> [String: Any] in
      do { return try await self.store.deletePack(packID: packID) }
      catch { throw Self.nativeError(error, message: "The local model could not be removed", code: 4) }
    }
  }

  private static func nativeError(_ error: Error, message: String, code: Int) -> NSError {
    let localError = error as? AlyteLocalModelError
    let category = localError?.failure.rawValue ?? AlyteLocalModelFailure.unknown.rawValue
    var userInfo: [String: Any] = [
      NSLocalizedDescriptionKey: message,
      NSLocalizedFailureReasonErrorKey: category,
      "failureCategory": category,
    ]
    if let stage = localError?.runtimeFailureStage {
      userInfo["failureStage"] = stage.rawValue
      // Release diagnostics are deliberately limited to finite, typed values. Never include
      // paths, prompts, model contents, generated output, or health data in this log.
      Self.activationLogger.error(
        "Local model activation failed category=\(category, privacy: .public) stage=\(stage.rawValue, privacy: .public)"
      )
    }
    return NSError(
      domain: "AlyteLocalModels",
      code: code,
      userInfo: userInfo
    )
  }
}
