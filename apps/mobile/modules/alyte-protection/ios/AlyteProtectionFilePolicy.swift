import Foundation

struct AlyteProtectionReport {
  let protectedPaths: [String]
  let missingSidecarPaths: [String]
}

enum AlyteProtectionError: Error {
  case primaryDatabaseMissing
  case sidecarsMissing([String])
  case dataProtectionVerificationFailed(String)
  case backupExclusionVerificationFailed(String)
}

final class AlyteProtectionFilePolicy {
  private let fileManager: FileManager

  init(fileManager: FileManager = .default) {
    self.fileManager = fileManager
  }

  func protectDatabaseFiles(at databaseURL: URL, requireSidecars: Bool) throws -> AlyteProtectionReport {
    let databasePath = databaseURL.path
    let sidecarPaths = ["\(databasePath)-wal", "\(databasePath)-shm"]
    guard fileManager.fileExists(atPath: databasePath) else {
      throw AlyteProtectionError.primaryDatabaseMissing
    }

    let missingSidecars = sidecarPaths.filter { !fileManager.fileExists(atPath: $0) }
    if requireSidecars && !missingSidecars.isEmpty {
      throw AlyteProtectionError.sidecarsMissing(missingSidecars)
    }

    var protectedPaths: [String] = []
    for path in [databasePath] + sidecarPaths where fileManager.fileExists(atPath: path) {
      try protect(path: path)
      protectedPaths.append(path)
    }

    return AlyteProtectionReport(
      protectedPaths: protectedPaths,
      missingSidecarPaths: missingSidecars
    )
  }

  private func protect(path: String) throws {
    do {
      try fileManager.setAttributes(
        [.protectionKey: FileProtectionType.complete],
        ofItemAtPath: path
      )
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var url = URL(fileURLWithPath: path)
      try url.setResourceValues(values)

      let attributes = try fileManager.attributesOfItem(atPath: path)
      guard let protection = attributes[.protectionKey] as? FileProtectionType,
            protection == FileProtectionType.complete else {
        throw AlyteProtectionError.dataProtectionVerificationFailed(path)
      }
      let resourceValues = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
      guard resourceValues.isExcludedFromBackup == true else {
        throw AlyteProtectionError.backupExclusionVerificationFailed(path)
      }
    } catch let error as AlyteProtectionError {
      throw error
    } catch {
      throw AlyteProtectionError.dataProtectionVerificationFailed(path)
    }
  }
}
