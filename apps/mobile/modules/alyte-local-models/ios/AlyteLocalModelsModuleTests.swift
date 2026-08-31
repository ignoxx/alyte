import XCTest
import Foundation
@testable import AlyteLocalModels

final class AlyteLocalModelsModuleTests: XCTestCase {
  func testManifestPinsTheReviewedArtifactAndRuntime() {
    XCTAssertEqual(AlyteLocalModelManifest.packID, "qwen3-vl-2b-instruct-q4-k-m")
    XCTAssertEqual(AlyteLocalModelManifest.bytes, 1_552_463_168)
    XCTAssertEqual(AlyteLocalModelManifest.artifactBytes, 1_107_409_952)
    XCTAssertEqual(AlyteLocalModelManifest.projectorBytes, 445_053_216)
    XCTAssertEqual(
      AlyteLocalModelManifest.sha256,
      "089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae"
    )
    XCTAssertEqual(
      AlyteLocalModelManifest.projectorSha256,
      "f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82"
    )
    XCTAssertEqual(AlyteLocalModelManifest.runtimeRevision, "bb4caa7540188872173c44d161602d9271386413")
    XCTAssertTrue(AlyteLocalModelManifest.artifactURL.contains("/resolve/\(AlyteLocalModelManifest.artifactRevision)/"))
    XCTAssertFalse(AlyteLocalModelManifest.artifactURL.contains("/main/"))
    XCTAssertTrue(AlyteLocalModelManifest.projectorURL.contains("/resolve/\(AlyteLocalModelManifest.projectorRevision)/"))
  }

  func testRedirectPolicyAcceptsExactReviewedHuggingFaceHosts() {
    for host in AlyteLocalModelManifest.allowedHosts {
      XCTAssertTrue(
        AlyteLocalModelManifest.isAllowedRedirect(URL(string: "https://\(host)/file")!),
        host
      )
    }
  }

  func testRedirectPolicyRejectsDowngradeCredentialsLookalikesAndUnlistedHosts() {
    for url in [
      "http://us.aws.cdn.hf.co/file",
      "https://user:pass@us.aws.cdn.hf.co/file",
      "https://us.aws.cdn.hf.co.evil.example/file",
      "https://eu.aws.cdn.hf.co/file",
      "https://cdn.us.aws.cdn.hf.co/file",
      "https://example.com/file",
    ] {
      XCTAssertFalse(AlyteLocalModelManifest.isAllowedRedirect(URL(string: url)!))
    }
  }
}
