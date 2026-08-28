import CryptoKit
import Foundation
import Security

/**
 * The only persistence seam for the device result key. Production uses the Keychain store below;
 * the in-memory implementation is intentionally internal and is used by the native XCTest
 * harness, never by module composition.
 */
protocol AlyteDeviceCryptoKeyStore {
  func read() throws -> Data?
  func write(_ value: Data) throws
}

enum AlyteDeviceCryptoFailureCategory: String {
  case envelopeInvalid = "cloud_result_envelope_invalid"
  case contextInvalid = "cloud_result_context_invalid"
  case contextMismatch = "cloud_result_context_mismatch"
  case keyInvalid = "cloud_result_key_invalid"
  case plaintextTooLarge = "cloud_result_plaintext_too_large"
  case decryptionFailed = "cloud_result_decryption_failed"
  case keychainFailure = "device_crypto_keychain_failure"
  case nativeFailure = "device_crypto_native_failure"
}

enum AlyteDeviceCryptoError: Error {
  case envelopeInvalid
  case contextInvalid
  case contextMismatch
  case keyInvalid
  case plaintextTooLarge
  case decryptionFailed
  case keychainFailure

  var failureCategory: AlyteDeviceCryptoFailureCategory {
    switch self {
    case .envelopeInvalid:
      return .envelopeInvalid
    case .contextInvalid:
      return .contextInvalid
    case .contextMismatch:
      return .contextMismatch
    case .keyInvalid:
      return .keyInvalid
    case .plaintextTooLarge:
      return .plaintextTooLarge
    case .decryptionFailed:
      return .decryptionFailed
    case .keychainFailure:
      return .keychainFailure
    }
  }
}

final class AlyteDeviceCryptoKeychainStore: AlyteDeviceCryptoKeyStore {
  static let defaultService = "app.alyte.device-crypto"
  static let defaultAccount = "cloud-result-decryption-key-v1"

  private let service: String
  private let account: String
  private let lock = NSLock()

  init(
    service: String = AlyteDeviceCryptoKeychainStore.defaultService,
    account: String = AlyteDeviceCryptoKeychainStore.defaultAccount
  ) {
    self.service = service
    self.account = account
  }

  private var identity: [String: Any] {
    let value: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    return value
  }

  func read() throws -> Data? {
    lock.lock()
    defer { lock.unlock() }

    var query = identity
    query[kSecReturnData as String] = kCFBooleanTrue as Any
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw AlyteDeviceCryptoError.keychainFailure
    }
    return data
  }

  func write(_ value: Data) throws {
    lock.lock()
    defer { lock.unlock() }

    let identity = self.identity
    var item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecValueData as String: value,
    ]
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess || status == errSecDuplicateItem else {
      throw AlyteDeviceCryptoError.keychainFailure
    }
    if status == errSecDuplicateItem {
      let update: [String: Any] = [
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        kSecValueData as String: value,
      ]
      guard SecItemUpdate(identity as CFDictionary, update as CFDictionary) == errSecSuccess else {
        throw AlyteDeviceCryptoError.keychainFailure
      }
    }
  }
}

private struct AlyteDeviceCryptoEnvelope {
  let schemaVersion: String
  let keyAgreement: String
  let kdf: String
  let cipher: String
  let requestId: String
  let contractVersion: String
  let resultSchemaVersion: String
  let handlerVersion: Int
  let ephemeralPublicKey: String
  let salt: String
  let nonce: String
  let ciphertext: String
  let authenticationTag: String

  private static let expectedKeys: Set<String> = [
    "schemaVersion",
    "keyAgreement",
    "kdf",
    "cipher",
    "requestId",
    "contractVersion",
    "resultSchemaVersion",
    "handlerVersion",
    "ephemeralPublicKey",
    "salt",
    "nonce",
    "ciphertext",
    "authenticationTag",
  ]

  init(json: String) throws {
    guard json.utf8.count <= 2_000_000, !Self.hasDuplicateJSONObjectKeys(json) else {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }
    guard let data = json.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let dictionary = object as? [String: Any],
      Set(dictionary.keys) == Self.expectedKeys
    else {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }

    guard
      let schemaVersion = dictionary["schemaVersion"] as? String,
      let keyAgreement = dictionary["keyAgreement"] as? String,
      let kdf = dictionary["kdf"] as? String,
      let cipher = dictionary["cipher"] as? String,
      let requestId = dictionary["requestId"] as? String,
      let contractVersion = dictionary["contractVersion"] as? String,
      let resultSchemaVersion = dictionary["resultSchemaVersion"] as? String,
      let handlerNumber = dictionary["handlerVersion"] as? NSNumber,
      let ephemeralPublicKey = dictionary["ephemeralPublicKey"] as? String,
      let salt = dictionary["salt"] as? String,
      let nonce = dictionary["nonce"] as? String,
      let ciphertext = dictionary["ciphertext"] as? String,
      let authenticationTag = dictionary["authenticationTag"] as? String,
      CFGetTypeID(handlerNumber) != CFBooleanGetTypeID(),
      handlerNumber.doubleValue.isFinite,
      handlerNumber.doubleValue.rounded() == handlerNumber.doubleValue,
      handlerNumber.intValue >= 1,
      handlerNumber.intValue <= 1_000,
      handlerNumber.intValue == Int(handlerNumber.doubleValue),
      schemaVersion == "alyte.cloud-result-envelope.v1",
      keyAgreement == "P-256-ECDH",
      kdf == "HKDF-SHA-256",
      cipher == "AES-256-GCM",
      Self.isRequestId(requestId),
      Self.isBoundedVersion(contractVersion),
      Self.isBoundedVersion(resultSchemaVersion)
    else {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }

    guard
      Self.isCanonicalBase64url(ephemeralPublicKey, expectedBytes: 65),
      Self.isCanonicalBase64url(salt, expectedBytes: 32),
      Self.isCanonicalBase64url(nonce, expectedBytes: 12),
      Self.isCanonicalBase64url(authenticationTag, expectedBytes: 16),
      Self.isCanonicalBase64url(ciphertext),
      let encryptedBytes = try? Self.decodeBase64url(ciphertext),
      encryptedBytes.count >= 1,
      encryptedBytes.count <= 262_144,
      Self.isValidP256Point(ephemeralPublicKey)
    else {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }

    self.schemaVersion = schemaVersion
    self.keyAgreement = keyAgreement
    self.kdf = kdf
    self.cipher = cipher
    self.requestId = requestId
    self.contractVersion = contractVersion
    self.resultSchemaVersion = resultSchemaVersion
    self.handlerVersion = handlerNumber.intValue
    self.ephemeralPublicKey = ephemeralPublicKey
    self.salt = salt
    self.nonce = nonce
    self.ciphertext = ciphertext
    self.authenticationTag = authenticationTag
  }

  private static func isRequestId(_ value: String) -> Bool {
    isASCII(value, maxBytes: 128, allowsTilde: true)
  }

  private static func isBoundedVersion(_ value: String) -> Bool {
    isASCII(value, maxBytes: 128, allowsTilde: false)
  }

  private static func isASCII(_ value: String, maxBytes: Int, allowsTilde: Bool) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= maxBytes else { return false }
    guard isAlphaNumeric(bytes[0]) else { return false }
    return bytes.dropFirst().allSatisfy { byte in
      isAlphaNumeric(byte) || byte == 0x2e || byte == 0x5f || byte == 0x2d || (allowsTilde && byte == 0x7e)
    }
  }

  private static func isAlphaNumeric(_ byte: UInt8) -> Bool {
    (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
  }

  private static func isCanonicalBase64url(_ value: String, expectedBytes: Int? = nil) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.allSatisfy({
      ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2d || $0 == 0x5f
    }) else { return false }
    guard bytes.count % 4 != 1 else { return false }
    if let expectedBytes, bytes.count != Int(ceil(Double(expectedBytes * 8) / 6.0)) {
      return false
    }
    let remainder = bytes.count % 4
    let last = base64urlSextet(bytes[bytes.count - 1])
    if remainder == 2 && (last & 0x0f) != 0 { return false }
    if remainder == 3 && (last & 0x03) != 0 { return false }
    guard let decoded = try? decodeBase64url(value) else { return false }
    if let expectedBytes, decoded.count != expectedBytes { return false }
    return encodeBase64url(decoded) == value
  }

  private static func decodeBase64url(_ value: String) throws -> Data {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count % 4 != 1 else { throw AlyteDeviceCryptoError.envelopeInvalid }
    var standard = value.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4)
    guard let decoded = Data(base64Encoded: standard), encodeBase64url(decoded) == value else {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }
    return decoded
  }

  private static func encodeBase64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func base64urlSextet(_ byte: UInt8) -> UInt8 {
    if byte >= 0x41 && byte <= 0x5a { return byte - 0x41 }
    if byte >= 0x61 && byte <= 0x7a { return byte - 0x61 + 26 }
    if byte >= 0x30 && byte <= 0x39 { return byte - 0x30 + 52 }
    return byte == 0x2d ? 62 : 63
  }

  private static func isValidP256Point(_ value: String) -> Bool {
    guard let raw = try? decodeBase64url(value), raw.count == 65, raw.first == 0x04 else { return false }
    return (try? P256.KeyAgreement.PublicKey(x963Representation: raw)) != nil
  }

  /** JSONSerialization accepts duplicate object members; reject those before decoding. */
  private static func hasDuplicateJSONObjectKeys(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    var stack: [Set<String>?] = []
    var index = 0
    while index < bytes.count {
      switch bytes[index] {
      case 0x22: // string
        let start = index
        index += 1
        var closed = false
        while index < bytes.count {
          if bytes[index] == 0x5c {
            index += 2
          } else if bytes[index] == 0x22 {
            closed = true
            break
          } else {
            index += 1
          }
        }
        guard closed else { return false }
        var next = index + 1
        while next < bytes.count && (bytes[next] == 0x20 || bytes[next] == 0x09 || bytes[next] == 0x0a || bytes[next] == 0x0d) {
          next += 1
        }
        if next < bytes.count, bytes[next] == 0x3a, !stack.isEmpty, let keys = stack[stack.count - 1] {
          guard let key = try? JSONSerialization.jsonObject(
            with: Data(bytes[start...index]), options: [.fragmentsAllowed]
          ) as? String else { return false }
          if keys.contains(key) { return true }
          stack[stack.count - 1] = keys.union([key])
        }
      case 0x7b: // object
        stack.append(Set<String>())
      case 0x5b: // array
        stack.append(nil)
      case 0x7d, 0x5d:
        if !stack.isEmpty { stack.removeLast() }
      default:
        break
      }
      index += 1
    }
    return false
  }

  func binaryFields() throws -> (ephemeral: Data, salt: Data, nonce: Data, ciphertext: Data, tag: Data) {
    guard
      let ephemeral = try? Self.decodeBase64url(ephemeralPublicKey),
      let salt = try? Self.decodeBase64url(salt),
      let nonce = try? Self.decodeBase64url(nonce),
      let ciphertext = try? Self.decodeBase64url(ciphertext),
      let tag = try? Self.decodeBase64url(authenticationTag)
    else {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }
    return (ephemeral, salt, nonce, ciphertext, tag)
  }
}

/// CryptoKit and Keychain implementation behind the existing AlyteProtection module boundary.
final class AlyteDeviceCrypto {
  private static let hkdfInfoPrefix = Data("alyte/cloud-result-envelope/v1\0".utf8)
  private static let keyAgreementPrivateKeyBytes = 32
  private static let keyLock = NSLock()

  private let keyStore: AlyteDeviceCryptoKeyStore

  init(keyStore: AlyteDeviceCryptoKeyStore = AlyteDeviceCryptoKeychainStore()) {
    self.keyStore = keyStore
  }

  func publicKeyJWK() throws -> [String: String] {
    let key = try privateKey()
    let raw = key.publicKey.x963Representation
    guard raw.count == 65, raw.first == 0x04 else { throw AlyteDeviceCryptoError.keyInvalid }
    return [
      "kty": "EC",
      "crv": "P-256",
      "x": Self.encodeBase64url(Data(raw.dropFirst().prefix(32))),
      "y": Self.encodeBase64url(Data(raw.dropFirst(33).prefix(32))),
    ]
  }

  func decrypt(
    envelopeJSON: String,
    requestId: String,
    contractVersion: String,
    resultSchemaVersion: String,
    handlerVersion: Int
  ) throws -> Data {
    let envelope = try AlyteDeviceCryptoEnvelope(json: envelopeJSON)
    var aad = try associatedData(
      requestId: requestId,
      contractVersion: contractVersion,
      resultSchemaVersion: resultSchemaVersion,
      handlerVersion: handlerVersion
    )
    defer { aad.resetBytes(in: 0..<aad.count) }
    guard
      envelope.requestId == requestId,
      envelope.contractVersion == contractVersion,
      envelope.resultSchemaVersion == resultSchemaVersion,
      envelope.handlerVersion == handlerVersion
    else {
      throw AlyteDeviceCryptoError.contextMismatch
    }

    var fields = try envelope.binaryFields()
    defer {
      fields.ephemeral.resetBytes(in: 0..<fields.ephemeral.count)
      fields.salt.resetBytes(in: 0..<fields.salt.count)
      fields.nonce.resetBytes(in: 0..<fields.nonce.count)
      fields.ciphertext.resetBytes(in: 0..<fields.ciphertext.count)
      fields.tag.resetBytes(in: 0..<fields.tag.count)
    }
    let ephemeralPublicKey: P256.KeyAgreement.PublicKey
    do {
      ephemeralPublicKey = try P256.KeyAgreement.PublicKey(x963Representation: fields.ephemeral)
    } catch {
      throw AlyteDeviceCryptoError.envelopeInvalid
    }
    let privateKey = try privateKey()
    let sharedSecret: SharedSecret
    do {
      sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: ephemeralPublicKey)
    } catch {
      throw AlyteDeviceCryptoError.decryptionFailed
    }

    var info = Self.hkdfInfoPrefix
    info.append(aad)
    defer { info.resetBytes(in: 0..<info.count) }
    let symmetricKey = sharedSecret.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: fields.salt,
      sharedInfo: info,
      outputByteCount: 32
    )
    do {
      let nonce = try AES.GCM.Nonce(data: fields.nonce)
      let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: fields.ciphertext, tag: fields.tag)
      let plaintext = try AES.GCM.open(sealedBox, using: symmetricKey, authenticating: aad)
      guard !plaintext.isEmpty else { throw AlyteDeviceCryptoError.decryptionFailed }
      guard plaintext.count <= 262_144 else { throw AlyteDeviceCryptoError.plaintextTooLarge }
      return plaintext
    } catch let error as AlyteDeviceCryptoError {
      throw error
    } catch {
      throw AlyteDeviceCryptoError.decryptionFailed
    }
  }

  /// Returns plaintext as Data for the Expo bridge's Uint8Array mapping. Ownership transfers to
  /// the bridge; callers should clear the mutable JavaScript buffer after consuming it.
  func decryptData(
    envelopeJSON: String,
    requestId: String,
    contractVersion: String,
    resultSchemaVersion: String,
    handlerVersion: Int
  ) throws -> Data {
    return try decrypt(
      envelopeJSON: envelopeJSON,
      requestId: requestId,
      contractVersion: contractVersion,
      resultSchemaVersion: resultSchemaVersion,
      handlerVersion: handlerVersion
    )
  }

  private func privateKey() throws -> P256.KeyAgreement.PrivateKey {
    Self.keyLock.lock()
    defer { Self.keyLock.unlock() }

    let stored: Data?
    do {
      stored = try keyStore.read()
    } catch {
      throw AlyteDeviceCryptoError.keychainFailure
    }
    if var stored {
      defer { stored.resetBytes(in: 0..<stored.count) }
      guard stored.count == Self.keyAgreementPrivateKeyBytes else {
        throw AlyteDeviceCryptoError.keyInvalid
      }
      do {
        return try P256.KeyAgreement.PrivateKey(rawRepresentation: stored)
      } catch {
        throw AlyteDeviceCryptoError.keyInvalid
      }
    }

    let generated = P256.KeyAgreement.PrivateKey()
    var bytes = generated.rawRepresentation
    defer { bytes.resetBytes(in: 0..<bytes.count) }
    do {
      try keyStore.write(bytes)
    } catch {
      throw AlyteDeviceCryptoError.keychainFailure
    }
    return generated
  }

  private func associatedData(
    requestId: String,
    contractVersion: String,
    resultSchemaVersion: String,
    handlerVersion: Int
  ) throws -> Data {
    guard
      AlyteDeviceCryptoEnvelope.isRequestIdForContext(requestId),
      AlyteDeviceCryptoEnvelope.isVersionForContext(contractVersion),
      AlyteDeviceCryptoEnvelope.isVersionForContext(resultSchemaVersion),
      (1...1_000).contains(handlerVersion)
    else {
      throw AlyteDeviceCryptoError.contextInvalid
    }
    return Data(
      "{\"schemaVersion\":\"alyte.cloud-result-envelope.v1\",\"requestId\":\"\(requestId)\",\"contractVersion\":\"\(contractVersion)\",\"resultSchemaVersion\":\"\(resultSchemaVersion)\",\"handlerVersion\":\(handlerVersion)}".utf8
    )
  }

  private static func encodeBase64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

// Context validators are kept private to the envelope decoder but are exposed to the parent
// service through these narrow, non-sensitive predicates to keep AAD construction identical.
private extension AlyteDeviceCryptoEnvelope {
  static func isRequestIdForContext(_ value: String) -> Bool { isRequestId(value) }
  static func isVersionForContext(_ value: String) -> Bool { isBoundedVersion(value) }
}
