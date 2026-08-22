import ExpoModulesCore

public final class AlyteProtectionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AlyteProtection")

    AsyncFunction("protectDatabaseFiles") { (databasePath: String) throws -> [String: Any] in
      let path = Self.filePath(from: databasePath)
      let paths = [path, "\(path)-wal", "\(path)-shm"]
      var protectedPaths: [String] = []
      var missingSidecarPaths: [String] = []

      for candidate in paths {
        guard FileManager.default.fileExists(atPath: candidate) else {
          if candidate != path {
            missingSidecarPaths.append(candidate)
            continue
          }
          throw NSError(
            domain: "AlyteProtection",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "The local database file does not exist"]
          )
        }

        do {
          try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: candidate
          )

          var values = URLResourceValues()
          values.isExcludedFromBackup = true
          var url = URL(fileURLWithPath: candidate)
          try url.setResourceValues(values)

          let attributes = try FileManager.default.attributesOfItem(atPath: candidate)
          guard let protection = attributes[.protectionKey] as? FileProtectionType,
                protection == FileProtectionType.complete else {
            throw NSError(
              domain: "AlyteProtection",
              code: 2,
              userInfo: [NSLocalizedDescriptionKey: "Data Protection verification failed"]
            )
          }

          let resourceValues = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
          guard resourceValues.isExcludedFromBackup == true else {
            throw NSError(
              domain: "AlyteProtection",
              code: 3,
              userInfo: [NSLocalizedDescriptionKey: "iCloud Backup exclusion verification failed"]
            )
          }
          protectedPaths.append(candidate)
        } catch {
          throw NSError(
            domain: "AlyteProtection",
            code: 4,
            userInfo: [
              NSLocalizedDescriptionKey: "Could not protect local database path",
              NSUnderlyingErrorKey: error,
            ]
          )
        }
      }

      return [
        "protectedPaths": protectedPaths,
        "missingSidecarPaths": missingSidecarPaths,
      ]
    }
  }

  private static func filePath(from value: String) -> String {
    if value.hasPrefix("file://"), let url = URL(string: value) {
      return url.path
    }
    return value
  }
}
