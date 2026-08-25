import CryptoKit
import Foundation
import ZIPFoundation

struct AlyteZipExpectedEntry: Codable {
  let path: String
  let bytes: Int64
  let sha256: String
}

struct AlyteZipOperationResult {
  let operationId: String
  let phase: String
  let entryCount: Int
  let bytes: Int64
}

/**
 * ZIPFoundation is deliberately hidden behind this small, allowlist-only native boundary. The
 * caller supplies a staging directory and exact entries; the module never accepts ZIP input or
 * returns filenames/content in operation results.
 */
final class AlyteProtectionArchive {
  private let fileManager: FileManager
  private let lock = NSLock()
  private var operations: [String: Progress] = [:]

  init(fileManager: FileManager = .default) {
    self.fileManager = fileManager
  }

  func create(
    operationId: String,
    stagingURL: URL,
    partialURL: URL,
    expected: [AlyteZipExpectedEntry]
  ) throws -> AlyteZipOperationResult {
    let stagingRoot = stagingURL.standardizedFileURL
    let partial = partialURL.standardizedFileURL
    try validateOperationId(operationId)
    try validateExpectedEntries(expected)
    let exportsRoot = try exportNamespace(for: stagingRoot, kind: .staging)
    guard stagingRoot.path != partial.path else { throw AlyteProtectionError.archiveInvalidInput }
    guard try exportNamespace(for: partial, kind: .partial) == exportsRoot else {
      throw AlyteProtectionError.archivePathEscape
    }
    guard fileManager.fileExists(atPath: stagingRoot.path) else {
      throw AlyteProtectionError.fileMissing
    }
    guard !fileManager.fileExists(atPath: partial.path) else {
      throw AlyteProtectionError.archiveInvalidInput
    }
    try rejectSymlinksAndCollectEntries(stagingRoot, expected: expected)

    let progress = Progress(totalUnitCount: max(1, expected.reduce(Int64(0)) { $0 + $1.bytes }))
    lock.lock()
    operations[operationId] = progress
    lock.unlock()
    defer {
      lock.lock()
      operations.removeValue(forKey: operationId)
      lock.unlock()
    }

    do {
      let archive = try Archive(url: partial, accessMode: .create)
      for item in expected.sorted(by: { $0.path < $1.path }) {
        try checkCancellation(progress)
        let source = try containedURL(item.path, in: stagingRoot)
        let actual = try hashAndSize(source)
        guard actual.bytes == item.bytes, actual.sha256 == item.sha256 else {
          throw AlyteProtectionError.archiveChecksum
        }
        try archive.addEntry(
          with: item.path,
          fileURL: source,
          compressionMethod: .deflate,
          bufferSize: 1024 * 1024,
          progress: progress
        )
      }
      try verifyArchive(at: partial, expected: expected, progress: progress)
      let archiveBytes = try fileSize(partial)
      return AlyteZipOperationResult(
        operationId: operationId,
        phase: "verified",
        entryCount: expected.count,
        bytes: archiveBytes
      )
    } catch {
      try? fileManager.removeItem(at: partial)
      if let error = error as? AlyteProtectionError { throw error }
      if let archiveError = error as? Archive.ArchiveError {
        if case .cancelledOperation = archiveError { throw AlyteProtectionError.cancelled }
      }
      throw AlyteProtectionError.archiveFailure
    }
  }

  func promote(
    operationId: String,
    partialURL: URL,
    archiveURL: URL
  ) throws -> AlyteZipOperationResult {
    try validateOperationId(operationId)
    let partial = partialURL.standardizedFileURL
    let destination = archiveURL.standardizedFileURL
    let exportsRoot = try exportNamespace(for: partial, kind: .partial)
    guard partial.path.hasSuffix(".zip.partial"), destination.path.hasSuffix(".zip") else {
      throw AlyteProtectionError.archiveInvalidInput
    }
    guard try exportNamespace(for: destination, kind: .archive) == exportsRoot else {
      throw AlyteProtectionError.archivePathEscape
    }
    guard fileManager.fileExists(atPath: partial.path) else { throw AlyteProtectionError.fileMissing }
    guard !fileManager.fileExists(atPath: destination.path) else {
      throw AlyteProtectionError.archiveInvalidInput
    }
    do {
      try fileManager.moveItem(at: partial, to: destination)
      return AlyteZipOperationResult(
        operationId: operationId,
        phase: "promoted",
        entryCount: 0,
        bytes: try fileSize(destination)
      )
    } catch {
      throw AlyteProtectionError.archiveFailure
    }
  }

  func cancel(
    operationId: String,
    partialURL: URL
  ) throws -> AlyteZipOperationResult {
    try validateOperationId(operationId)
    lock.lock()
    let progress = operations[operationId]
    progress?.cancel()
    lock.unlock()
    let partial = partialURL.standardizedFileURL
    _ = try exportNamespace(for: partial, kind: .partial)
    if fileManager.fileExists(atPath: partial.path) {
      try? fileManager.removeItem(at: partial)
    }
    guard !fileManager.fileExists(atPath: partial.path) else {
      throw AlyteProtectionError.archiveFailure
    }
    return AlyteZipOperationResult(
      operationId: operationId,
      phase: "cancelled",
      entryCount: 0,
      bytes: 0
    )
  }

  private func validateOperationId(_ value: String) throws {
    guard !value.isEmpty, value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
      throw AlyteProtectionError.archiveInvalidInput
    }
  }

  private enum ExportPathKind {
    case staging
    case partial
    case archive
  }

  private func exportNamespace(for url: URL, kind: ExportPathKind) throws -> URL {
    let standardized = url.standardizedFileURL
    let components = standardized.path.split(separator: "/").map(String.init)
    guard let exportsIndex = components.lastIndex(of: "exports"), exportsIndex > 0,
          components[exportsIndex - 1] == "alyte-protected",
          exportsIndex == components.count - 2 else {
      throw AlyteProtectionError.archivePathEscape
    }
    let name = components[exportsIndex + 1]
    let expectedPattern: String
    switch kind {
    case .staging:
      expectedPattern = #"^[A-Za-z0-9_-]+\.partial$"#
    case .partial:
      expectedPattern = #"^[A-Za-z0-9_-]+\.zip\.partial$"#
    case .archive:
      expectedPattern = #"^[A-Za-z0-9_-]+\.zip$"#
    }
    guard name.range(of: expectedPattern, options: .regularExpression) != nil else {
      throw AlyteProtectionError.archiveInvalidInput
    }
    return standardized.deletingLastPathComponent().standardizedFileURL
  }

  private func validateExpectedEntries(_ entries: [AlyteZipExpectedEntry]) throws {
    var paths = Set<String>()
    for entry in entries {
      guard !entry.path.isEmpty,
            !entry.path.contains("\\"),
            !entry.path.contains("\u{0}"),
            !entry.path.hasPrefix("/"),
            entry.path.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." }),
            entry.bytes >= 0,
            entry.sha256.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
            paths.insert(entry.path).inserted else {
        throw AlyteProtectionError.archiveInvalidInput
      }
    }
  }

  private func rejectSymlinksAndCollectEntries(
    _ root: URL,
    expected: [AlyteZipExpectedEntry]
  ) throws {
    let expectedPaths = Set(expected.map(\.path))
    var foundPaths = Set<String>()
    guard let enumerator = fileManager.enumerator(
      at: root,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey],
      options: []
    ) else { throw AlyteProtectionError.archiveFailure }
    while let value = enumerator.nextObject() as? URL {
      let resource = try value.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey])
      if resource.isSymbolicLink == true { throw AlyteProtectionError.archiveSymlink }
      if resource.isDirectory == true { continue }
      guard resource.isRegularFile == true else { throw AlyteProtectionError.archiveInvalidInput }
      let relative = String(value.standardizedFileURL.path.dropFirst(root.path.count + 1))
      guard expectedPaths.contains(relative) else { throw AlyteProtectionError.archiveEntryMismatch }
      foundPaths.insert(relative)
    }
    guard foundPaths == expectedPaths else { throw AlyteProtectionError.archiveEntryMismatch }
  }

  private func containedURL(_ relativePath: String, in root: URL) throws -> URL {
    let candidate = root.appendingPathComponent(relativePath, isDirectory: false).standardizedFileURL
    let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
    guard candidate.path.hasPrefix(rootPrefix), candidate.path != root.path else {
      throw AlyteProtectionError.archivePathEscape
    }
    let resource = try candidate.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
    guard resource.isSymbolicLink != true, resource.isRegularFile == true else {
      throw AlyteProtectionError.archiveSymlink
    }
    return candidate
  }

  private func verifyArchive(
    at url: URL,
    expected: [AlyteZipExpectedEntry],
    progress: Progress
  ) throws {
    let archive: Archive
    do {
      archive = try Archive(url: url, accessMode: .read)
    } catch {
      throw AlyteProtectionError.archiveFailure
    }
    let expectedByPath = Dictionary(uniqueKeysWithValues: expected.map { ($0.path, $0) })
    let entries = Array(archive)
    guard entries.count == expected.count else { throw AlyteProtectionError.archiveEntryMismatch }
    for entry in entries {
      try checkCancellation(progress)
      guard entry.type == .file, let item = expectedByPath[entry.path], entry.uncompressedSize == UInt64(item.bytes) else {
        throw AlyteProtectionError.archiveEntryMismatch
      }
      var hasher = SHA256()
      do {
        _ = try archive.extract(entry, bufferSize: 1024 * 1024, skipCRC32: false, progress: progress) { data in
          hasher.update(data: data)
        }
      } catch let error as Archive.ArchiveError {
        switch error {
        case .invalidCRC32:
          throw AlyteProtectionError.archiveChecksum
        case .cancelledOperation:
          throw AlyteProtectionError.cancelled
        default:
          throw AlyteProtectionError.archiveFailure
        }
      } catch {
        throw AlyteProtectionError.archiveFailure
      }
      let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
      guard digest == item.sha256 else { throw AlyteProtectionError.archiveChecksum }
    }
  }

  private func hashAndSize(_ url: URL) throws -> (bytes: Int64, sha256: String) {
    let policy = AlyteProtectionFilePolicy(fileManager: fileManager)
    let hash = try policy.hashFile(at: url)
    return (try fileSize(url), hash)
  }

  private func fileSize(_ url: URL) throws -> Int64 {
    let attributes = try fileManager.attributesOfItem(atPath: url.path)
    guard let size = attributes[.size] as? NSNumber else { throw AlyteProtectionError.archiveFailure }
    return size.int64Value
  }

  private func checkCancellation(_ progress: Progress) throws {
    if progress.isCancelled { throw AlyteProtectionError.cancelled }
  }
}
