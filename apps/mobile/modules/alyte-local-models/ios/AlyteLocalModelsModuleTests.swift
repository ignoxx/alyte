import XCTest
import Foundation
@testable import AlyteLocalModels

final class AlyteLocalModelsModuleTests: XCTestCase {
  func testManifestPinsTheReviewedArtifactAndRuntime() {
    XCTAssertEqual(AlyteLocalModelManifest.packID, "gemma-4-e2b-it-q4-0")
    XCTAssertEqual(AlyteLocalModelManifest.bytes, 2_841_481_184)
    XCTAssertEqual(
      AlyteLocalModelManifest.sha256,
      "8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52"
    )
    XCTAssertEqual(AlyteLocalModelManifest.runtimeRevision, "bb4caa7540188872173c44d161602d9271386413")
    XCTAssertTrue(AlyteLocalModelManifest.artifactURL.contains("/resolve/\(AlyteLocalModelManifest.artifactRevision)/"))
    XCTAssertFalse(AlyteLocalModelManifest.artifactURL.contains("/main/"))
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
