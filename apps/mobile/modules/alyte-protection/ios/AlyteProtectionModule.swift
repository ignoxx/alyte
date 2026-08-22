import ExpoModulesCore
import Foundation

public final class AlyteProtectionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlyteProtection")

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
}
