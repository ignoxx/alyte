import CryptoKit
import Foundation
import Security
import XCTest
@testable import AlyteProtection

private final class MemoryDeviceKeyStore: AlyteDeviceCryptoKeyStore {
  var value: Data?
  private(set) var writes = 0

  init(value: Data? = nil) {
    self.value = value
  }

  func read() throws -> Data? { value }

  func write(_ value: Data) throws {
    writes += 1
    self.value = value
  }
}

final class AlyteDeviceCryptoTests: XCTestCase {
  func testProductionKeychainPersistsAcrossRecreationWithDeviceOnlyAccessibility() throws {
    let namespace = UUID().uuidString
    let serviceName = "app.alyte.test.device-crypto.\(namespace)"
    let accountName = "cloud-result-decryption-key-v1"
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: serviceName,
      kSecAttrAccount as String: accountName,
    ]
    SecItemDelete(query as CFDictionary)
    defer { SecItemDelete(query as CFDictionary) }

    let entitlementProbe: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: serviceName + ".probe",
      kSecAttrAccount as String: accountName,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecValueData as String: Data([0x01]),
    ]
    let entitlementStatus = SecItemAdd(entitlementProbe as CFDictionary, nil)
    if entitlementStatus == errSecMissingEntitlement {
      throw XCTSkip("SwiftPM XCTest host has no application Keychain entitlement; use the signed Expo app smoke check")
    }
    XCTAssertEqual(entitlementStatus, errSecSuccess)
    defer {
      SecItemDelete([
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: serviceName + ".probe",
        kSecAttrAccount as String: accountName,
      ] as CFDictionary)
    }

    let first = try AlyteDeviceCrypto(
      keyStore: AlyteDeviceCryptoKeychainStore(service: serviceName, account: accountName)
    ).publicKeyJWK()
    let second = try AlyteDeviceCrypto(
      keyStore: AlyteDeviceCryptoKeychainStore(service: serviceName, account: accountName)
    ).publicKeyJWK()

    XCTAssertEqual(first, second)
    XCTAssertEqual(Set(first.keys), ["kty", "crv", "x", "y"])
    XCTAssertNil(first["d"])

    var result: CFTypeRef?
    let status = SecItemCopyMatching(
      query.merging([kSecReturnAttributes as String: kCFBooleanTrue as Any]) { _, new in new }
        as CFDictionary,
      &result
    )
    XCTAssertEqual(status, errSecSuccess)
    let attributes = try XCTUnwrap(result as? [String: Any])
    XCTAssertEqual(
      attributes[kSecAttrAccessible as String] as? String,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
    )
  }

  func testPrivateKeyPersistsAcrossServiceRecreationAndOnlyPublicJWKLeavesBoundary() throws {
    let store = MemoryDeviceKeyStore()
    let first = try AlyteDeviceCrypto(keyStore: store).publicKeyJWK()
    let second = try AlyteDeviceCrypto(keyStore: store).publicKeyJWK()

    XCTAssertEqual(first, second)
    XCTAssertEqual(store.writes, 1)
    XCTAssertEqual(Set(first.keys), ["kty", "crv", "x", "y"])
    XCTAssertNil(first["d"])
    XCTAssertEqual(first["kty"], "EC")
    XCTAssertEqual(first["crv"], "P-256")
    XCTAssertEqual(first["x"]?.count, 43)
    XCTAssertEqual(first["y"]?.count, 43)
  }

  func testDecryptsTheExactAuthoritativeCloudResultVector() throws {
    let vector = try readAuthoritativeVector()
    let privateBytes = try decodeBase64url(try string(vector["devicePrivateKeyJwk"] as! [String: Any], "d"))
    let store = MemoryDeviceKeyStore(value: privateBytes)
    let service = AlyteDeviceCrypto(keyStore: store)
    let context = try context(from: vector["context"] as! [String: Any])

    let plaintext = try service.decrypt(
      envelopeJSON: try string(vector, "serializedEnvelope"),
      requestId: context.requestId,
      contractVersion: context.contractVersion,
      resultSchemaVersion: context.resultSchemaVersion,
      handlerVersion: context.handlerVersion
    )
    XCTAssertEqual(plaintext, Data("synthetic-result-118".utf8))
    XCTAssertEqual(try encodeBase64url(plaintext), try string(vector, "plaintextBase64url"))
  }

  func testRejectsContextTamperingAndAuthenticatedCiphertextChanges() throws {
    let vector = try readAuthoritativeVector()
    let privateBytes = try decodeBase64url(try string(vector["devicePrivateKeyJwk"] as! [String: Any], "d"))
    let service = AlyteDeviceCrypto(keyStore: MemoryDeviceKeyStore(value: privateBytes))
    let context = try context(from: vector["context"] as! [String: Any])
    let serialized = try string(vector, "serializedEnvelope")
    let envelope = try envelopeDictionary(serialized)

    XCTAssertThrowsError(try service.decrypt(
      envelopeJSON: serialized,
      requestId: context.requestId,
      contractVersion: context.contractVersion,
      resultSchemaVersion: context.resultSchemaVersion,
      handlerVersion: context.handlerVersion + 1
    )) { error in
      XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .contextMismatch)
    }

    for field in ["ciphertext", "authenticationTag"] {
      var tampered = envelope
      let original = try string(tampered, field)
      tampered[field] = try mutateBase64url(original)
      XCTAssertThrowsError(try service.decrypt(
        envelopeJSON: try serialize(tampered),
        requestId: context.requestId,
        contractVersion: context.contractVersion,
        resultSchemaVersion: context.resultSchemaVersion,
        handlerVersion: context.handlerVersion
      )) { error in
        XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .decryptionFailed)
      }
    }
  }

  func testRejectsUnsupportedAlgorithmsMalformedEncodingOffCurveAndOversizedCiphertext() throws {
    let vector = try readAuthoritativeVector()
    let privateBytes = try decodeBase64url(try string(vector["devicePrivateKeyJwk"] as! [String: Any], "d"))
    let service = AlyteDeviceCrypto(keyStore: MemoryDeviceKeyStore(value: privateBytes))
    let context = try context(from: vector["context"] as! [String: Any])
    let serialized = try string(vector, "serializedEnvelope")
    let envelope = try envelopeDictionary(serialized)

    for (field, value) in [
      ("schemaVersion", "alyte.cloud-result-envelope.v2"),
      ("keyAgreement", "X25519-ECDH"),
      ("kdf", "HKDF-SHA-512"),
      ("cipher", "AES-128-GCM"),
      ("nonce", "!")
    ] {
      var invalid = envelope
      invalid[field] = value
      XCTAssertThrowsError(try service.decrypt(
        envelopeJSON: try serialize(invalid),
        requestId: context.requestId,
        contractVersion: context.contractVersion,
        resultSchemaVersion: context.resultSchemaVersion,
        handlerVersion: context.handlerVersion
      )) { error in
        XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .envelopeInvalid)
      }
    }

    var offCurve = envelope
    offCurve["ephemeralPublicKey"] = try encodeBase64url(Data(repeating: 0, count: 65))
    XCTAssertThrowsError(try service.decrypt(
      envelopeJSON: try serialize(offCurve),
      requestId: context.requestId,
      contractVersion: context.contractVersion,
      resultSchemaVersion: context.resultSchemaVersion,
      handlerVersion: context.handlerVersion
    )) { error in
      XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .envelopeInvalid)
    }

    var oversized = envelope
    oversized["ciphertext"] = try encodeBase64url(Data(repeating: 0, count: 262_145))
    XCTAssertThrowsError(try service.decrypt(
      envelopeJSON: try serialize(oversized),
      requestId: context.requestId,
      contractVersion: context.contractVersion,
      resultSchemaVersion: context.resultSchemaVersion,
      handlerVersion: context.handlerVersion
    )) { error in
      XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .envelopeInvalid)
    }
  }

  func testRejectsDuplicateFieldsCorruptKeysAndNeverIncludesSensitiveTextInErrors() throws {
    let vector = try readAuthoritativeVector()
    let privateBytes = try decodeBase64url(try string(vector["devicePrivateKeyJwk"] as! [String: Any], "d"))
    let context = try context(from: vector["context"] as! [String: Any])
    let service = AlyteDeviceCrypto(keyStore: MemoryDeviceKeyStore(value: Data(repeating: 0, count: 32)))
    let secret = "synthetic-result-118"

    XCTAssertThrowsError(try service.decrypt(
      envelopeJSON: "{\"schemaVersion\":\"alyte.cloud-result-envelope.v1\",\"schemaVersion\":\"alyte.cloud-result-envelope.v1\"}",
      requestId: context.requestId,
      contractVersion: context.contractVersion,
      resultSchemaVersion: context.resultSchemaVersion,
      handlerVersion: context.handlerVersion
    )) { error in
      XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .envelopeInvalid)
      XCTAssertFalse(String(describing: error).contains(secret))
      XCTAssertFalse(String(describing: error).contains(try! encodeBase64url(privateBytes)))
    }

    XCTAssertThrowsError(try service.decrypt(
      envelopeJSON: try string(vector, "serializedEnvelope"),
      requestId: context.requestId,
      contractVersion: context.contractVersion,
      resultSchemaVersion: context.resultSchemaVersion,
      handlerVersion: context.handlerVersion
    )) { error in
      XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .keyInvalid)
      XCTAssertFalse(String(describing: error).contains(secret))
    }
  }

  func testMissingKeyGeneratesOnceAndMalformedStoredKeyFailsClosed() throws {
    let missing = MemoryDeviceKeyStore()
    _ = try AlyteDeviceCrypto(keyStore: missing).publicKeyJWK()
    XCTAssertEqual(missing.writes, 1)
    XCTAssertNoThrow(try AlyteDeviceCrypto(keyStore: missing).publicKeyJWK())

    let corrupt = MemoryDeviceKeyStore(value: Data(repeating: 0xff, count: 7))
    XCTAssertThrowsError(try AlyteDeviceCrypto(keyStore: corrupt).publicKeyJWK()) { error in
      XCTAssertEqual((error as? AlyteDeviceCryptoError)?.failureCategory, .keyInvalid)
    }
  }

  private func readAuthoritativeVector() throws -> [String: Any] {
    let url: URL
    if let path = ProcessInfo.processInfo.environment["ALYTE_CLOUD_RESULT_VECTOR_PATH"] {
      url = URL(fileURLWithPath: path)
    } else if let resource = Bundle.module.url(forResource: "cloud-result-envelope-v1", withExtension: "json") {
      url = resource
    } else {
      throw NSError(domain: "AlyteDeviceCryptoTests", code: 1)
    }
    let data = try Data(contentsOf: url)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw NSError(domain: "AlyteDeviceCryptoTests", code: 2)
    }
    return object
  }

  private func context(from value: [String: Any]) throws -> (requestId: String, contractVersion: String, resultSchemaVersion: String, handlerVersion: Int) {
    guard
      let requestId = value["requestId"] as? String,
      let contractVersion = value["contractVersion"] as? String,
      let resultSchemaVersion = value["resultSchemaVersion"] as? String,
      let handlerNumber = value["handlerVersion"] as? NSNumber
    else { throw NSError(domain: "AlyteDeviceCryptoTests", code: 3) }
    return (requestId, contractVersion, resultSchemaVersion, handlerNumber.intValue)
  }

  private func string(_ value: [String: Any], _ key: String) throws -> String {
    guard let result = value[key] as? String else { throw NSError(domain: "AlyteDeviceCryptoTests", code: 4) }
    return result
  }

  private func envelopeDictionary(_ serialized: String) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(serialized.utf8)) as? [String: Any] else {
      throw NSError(domain: "AlyteDeviceCryptoTests", code: 5)
    }
    return value
  }

  private func serialize(_ value: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value)
    guard let result = String(data: data, encoding: .utf8) else { throw NSError(domain: "AlyteDeviceCryptoTests", code: 6) }
    return result
  }

  private func decodeBase64url(_ value: String) throws -> Data {
    var standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4)
    guard let result = Data(base64Encoded: standard) else { throw NSError(domain: "AlyteDeviceCryptoTests", code: 7) }
    return result
  }

  private func encodeBase64url(_ value: Data) throws -> String {
    value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private func mutateBase64url(_ value: String) throws -> String {
    guard let first = value.first else { throw NSError(domain: "AlyteDeviceCryptoTests", code: 8) }
    return (first == "A" ? "B" : "A") + value.dropFirst()
  }
}
