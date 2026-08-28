import ExpoModulesCore
import Foundation

public final class AlyteProtectionModule: Module {
  private static let archiveAdapter = AlyteProtectionArchive()
  private static let deviceCrypto = AlyteDeviceCrypto()

  public func definition() -> ModuleDefinition {
    Name("AlyteProtection")

    AsyncFunction("getDevicePublicKeyJwk") { () throws -> [String: String] in
      do {
        return try Self.deviceCrypto.publicKeyJWK()
      } catch {
        throw Self.deviceCryptoError(error, message: "Could not access the device crypto key", code: 7)
      }
    }

    AsyncFunction("decryptCloudResult") {
      (
        envelopeJSON: String,
        requestId: String,
        contractVersion: String,
        resultSchemaVersion: String,
        handlerVersion: Int
      ) throws -> Data in
      do {
        return try Self.deviceCrypto.decryptData(
          envelopeJSON: envelopeJSON,
          requestId: requestId,
          contractVersion: contractVersion,
          resultSchemaVersion: resultSchemaVersion,
          handlerVersion: handlerVersion
        )
      } catch {
        throw Self.deviceCryptoError(error, message: "Could not decrypt the cloud result", code: 8)
      }
    }

    Function("clearSnapshotShield") {
      AlyteSnapshotShield.shared.clear()
    }

    Function("markReactGateMounted") {
      AlyteSnapshotShield.shared.markReactGateMounted()
    }

    Function("isSnapshotShieldInstalled") {
      AlyteSnapshotShield.shared.isInstalled()
    }

    AsyncFunction("protectDatabaseFiles") { (databasePath: String, options: [String: Bool]) throws -> [String: Any] in
      let path = Self.filePath(from: databasePath)
      let requireSidecars = options["requireSidecars"] ?? true
      do {
        let report = try AlyteProtectionFilePolicy().protectDatabaseFiles(
          at: URL(fileURLWithPath: path),
          requireSidecars: requireSidecars
        )
        return [
          "protectedPaths": report.protectedPaths,
          "missingSidecarPaths": report.missingSidecarPaths,
        ]
      } catch {
        let category = Self.failureCategory(for: error)
        throw NSError(
          domain: "AlyteProtection",
          code: 1,
          userInfo: [
            NSLocalizedDescriptionKey: "Could not protect local database files",
            NSLocalizedFailureReasonErrorKey: category,
            "failureCategory": category,
          ]
        )
      }
    }

    AsyncFunction("protectPath") { (pathValue: String) throws -> [String: Any] in
      let path = Self.filePath(from: pathValue)
      do {
        let report = try AlyteProtectionFilePolicy().protectPath(at: URL(fileURLWithPath: path))
        return ["protectedPaths": report.protectedPaths]
      } catch {
        let category = Self.failureCategory(for: error)
        throw NSError(
          domain: "AlyteProtection",
          code: 2,
          userInfo: [
            NSLocalizedDescriptionKey: "Could not protect local health file",
            NSLocalizedFailureReasonErrorKey: category,
            "failureCategory": category,
          ]
        )
      }
    }

    AsyncFunction("hashFile") { (pathValue: String) throws -> String in
      let path = Self.filePath(from: pathValue)
      do {
        return try AlyteProtectionFilePolicy().hashFile(at: URL(fileURLWithPath: path))
      } catch {
        let category = Self.failureCategory(for: error)
        throw NSError(
          domain: "AlyteProtection",
          code: 3,
          userInfo: [
            NSLocalizedDescriptionKey: "Could not hash local health file",
            NSLocalizedFailureReasonErrorKey: category,
            "failureCategory": category,
          ]
        )
      }
    }

    AsyncFunction("createZip") {
      (
        operationId: String,
        stagingPath: String,
        partialArchivePath: String,
        entriesJSON: String
      ) async throws -> [String: Any] in
      do {
        guard let data = entriesJSON.data(using: .utf8) else {
          throw AlyteProtectionError.archiveInvalidInput
        }
        let expected = try JSONDecoder().decode([AlyteZipExpectedEntry].self, from: data)
        let result = try await Self.runArchiveOperation {
          try Self.archiveAdapter.create(
            operationId: operationId,
            stagingURL: URL(fileURLWithPath: Self.filePath(from: stagingPath)),
            partialURL: URL(fileURLWithPath: Self.filePath(from: partialArchivePath)),
            expected: expected
          )
        }
        return [
          "operationId": result.operationId,
          "phase": result.phase,
          "entryCount": result.entryCount,
          "bytes": result.bytes,
        ]
      } catch {
        throw Self.nativeError(error, message: "Could not create local export archive", code: 4)
      }
    }

    AsyncFunction("promoteZip") {
      (operationId: String, partialArchivePath: String, archivePath: String) async throws -> [String: Any] in
      do {
        let result = try await Self.runArchiveOperation {
          try Self.archiveAdapter.promote(
            operationId: operationId,
            partialURL: URL(fileURLWithPath: Self.filePath(from: partialArchivePath)),
            archiveURL: URL(fileURLWithPath: Self.filePath(from: archivePath))
          )
        }
        return [
          "operationId": result.operationId,
          "phase": result.phase,
          "entryCount": result.entryCount,
          "bytes": result.bytes,
        ]
      } catch {
        throw Self.nativeError(error, message: "Could not promote local export archive", code: 5)
      }
    }

    AsyncFunction("cancelZip") {
      (operationId: String, partialArchivePath: String) async throws -> [String: Any] in
      do {
        let result = try await Self.runArchiveOperation {
          try Self.archiveAdapter.cancel(
            operationId: operationId,
            partialURL: URL(fileURLWithPath: Self.filePath(from: partialArchivePath))
          )
        }
        return [
          "operationId": result.operationId,
          "phase": result.phase,
          "entryCount": result.entryCount,
          "bytes": result.bytes,
        ]
      } catch {
        throw Self.nativeError(error, message: "Could not cancel local export archive", code: 6)
      }
    }
  }

  private static func runArchiveOperation<T: Sendable>(
    _ operation: @escaping @Sendable () throws -> T
  ) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .utility).async {
        do {
          continuation.resume(returning: try operation())
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private static func filePath(from value: String) -> String {
    if value.hasPrefix("file://"), let url = URL(string: value) {
      return url.path
    }
    return value
  }

  private static func failureCategory(for error: Error) -> String {
    (error as? AlyteProtectionError)?.failureCategory.rawValue ??
      AlyteProtectionFailureCategory.nativeFailure.rawValue
  }

  private static func nativeError(_ error: Error, message: String, code: Int) -> NSError {
    let category = failureCategory(for: error)
    return NSError(
      domain: "AlyteProtection",
      code: code,
      userInfo: [
        NSLocalizedDescriptionKey: message,
        NSLocalizedFailureReasonErrorKey: category,
        "failureCategory": category,
      ]
    )
  }

  private static func deviceCryptoError(_ error: Error, message: String, code: Int) -> NSError {
    let category =
      (error as? AlyteDeviceCryptoError)?.failureCategory.rawValue
      ?? AlyteDeviceCryptoFailureCategory.nativeFailure.rawValue
    return NSError(
      domain: "AlyteProtection",
      code: code,
      userInfo: [
        NSLocalizedDescriptionKey: message,
        NSLocalizedFailureReasonErrorKey: category,
        "failureCategory": category,
      ]
    )
  }
}
