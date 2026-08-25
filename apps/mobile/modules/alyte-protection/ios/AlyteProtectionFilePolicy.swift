import Foundation
import CryptoKit

struct AlyteProtectionReport {
  let protectedPaths: [String]
  let missingSidecarPaths: [String]
}

enum AlyteProtectionFailureCategory: String {
  case primaryDatabaseMissing = "primary_database_missing"
  case dataProtectionVerification = "data_protection_verification"
  case backupExclusionVerification = "backup_exclusion_verification"
  case fileMissing = "file_missing"
  case invalidHash = "invalid_hash"
  case invalidFileType = "invalid_file_type"
  case archiveInvalidInput = "archive_invalid_input"
  case archiveSymlink = "archive_symlink_rejected"
  case archivePathEscape = "archive_path_escape"
  case archiveChecksum = "archive_checksum_mismatch"
  case archiveEntryMismatch = "archive_entry_mismatch"
  case archiveFailure = "archive_failure"
  case cancelled = "cancelled"
  case nativeFailure = "native_failure"
}

enum AlyteProtectionError: Error {
  case primaryDatabaseMissing
  case dataProtectionVerificationFailed
  case backupExclusionVerificationFailed
  case fileMissing
  case invalidHash
  case invalidFileType
  case archiveInvalidInput
  case archiveSymlink
  case archivePathEscape
  case archiveChecksum
  case archiveEntryMismatch
  case archiveFailure
  case cancelled

  var failureCategory: AlyteProtectionFailureCategory {
    switch self {
    case .primaryDatabaseMissing:
      return .primaryDatabaseMissing
    case .dataProtectionVerificationFailed:
      return .dataProtectionVerification
    case .backupExclusionVerificationFailed:
      return .backupExclusionVerification
    case .fileMissing:
      return .fileMissing
    case .invalidHash:
      return .invalidHash
    case .invalidFileType:
      return .invalidFileType
    case .archiveInvalidInput:
      return .archiveInvalidInput
    case .archiveSymlink:
      return .archiveSymlink
    case .archivePathEscape:
      return .archivePathEscape
    case .archiveChecksum:
      return .archiveChecksum
    case .archiveEntryMismatch:
      return .archiveEntryMismatch
    case .archiveFailure:
      return .archiveFailure
    case .cancelled:
      return .cancelled
    }
  }
}

struct AlyteProtectionEnvironment {
  let isSimulator: Bool
  let allowsDevelopmentSimulatorFallback: Bool

  static let current: Self = {
    #if targetEnvironment(simulator) && DEBUG
    return Self(isSimulator: true, allowsDevelopmentSimulatorFallback: true)
    #elseif targetEnvironment(simulator)
    return Self(isSimulator: true, allowsDevelopmentSimulatorFallback: false)
    #else
    return Self(isSimulator: false, allowsDevelopmentSimulatorFallback: false)
    #endif
  }()
}

final class AlyteProtectionFilePolicy {
  private let fileManager: FileManager
  private let environment: AlyteProtectionEnvironment

  init(
    fileManager: FileManager = .default,
    environment: AlyteProtectionEnvironment = .current
  ) {
    self.fileManager = fileManager
    self.environment = environment
  }

  func protectDatabaseFiles(at databaseURL: URL, requireSidecars _: Bool) throws -> AlyteProtectionReport {
    let databasePath = databaseURL.path
    let sidecarPaths = ["\(databasePath)-wal", "\(databasePath)-shm"]
    guard fileManager.fileExists(atPath: databasePath) else {
      throw AlyteProtectionError.primaryDatabaseMissing
    }

    let missingSidecars = sidecarPaths.filter { !fileManager.fileExists(atPath: $0) }

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

  func protectPath(at url: URL) throws -> AlyteProtectionReport {
    guard fileManager.fileExists(atPath: url.path) else {
      throw AlyteProtectionError.fileMissing
    }
    try protect(path: url.path)
    return AlyteProtectionReport(protectedPaths: [url.path], missingSidecarPaths: [])
  }

  func hashFile(at url: URL) throws -> String {
    guard fileManager.fileExists(atPath: url.path) else {
      throw AlyteProtectionError.fileMissing
    }
    do {
      let resourceValues = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
      guard resourceValues.isSymbolicLink != true, resourceValues.isRegularFile == true else {
        throw AlyteProtectionError.invalidFileType
      }
      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      var hasher = SHA256()
      while true {
        let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
        if data.isEmpty { break }
        hasher.update(data: data)
      }
      return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    } catch {
      throw AlyteProtectionError.invalidHash
    }
  }

  private func protect(path: String) throws {
    var dataProtectionVerified = false
    do {
      try fileManager.setAttributes(
        [.protectionKey: FileProtectionType.complete],
        ofItemAtPath: path
      )
      let attributes = try fileManager.attributesOfItem(atPath: path)
      dataProtectionVerified = (attributes[.protectionKey] as? FileProtectionType) == .complete
    } catch {
      guard environment.allowsDevelopmentSimulatorFallback && environment.isSimulator else {
        throw AlyteProtectionError.dataProtectionVerificationFailed
      }
    }

    if !dataProtectionVerified && !(environment.allowsDevelopmentSimulatorFallback && environment.isSimulator) {
      throw AlyteProtectionError.dataProtectionVerificationFailed
    }

    do {
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var url = URL(fileURLWithPath: path)
      try url.setResourceValues(values)
      let resourceValues = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
      guard resourceValues.isExcludedFromBackup == true else {
        throw AlyteProtectionError.backupExclusionVerificationFailed
      }
    } catch let error as AlyteProtectionError {
      throw error
    } catch {
      throw AlyteProtectionError.backupExclusionVerificationFailed
    }
  }
}
