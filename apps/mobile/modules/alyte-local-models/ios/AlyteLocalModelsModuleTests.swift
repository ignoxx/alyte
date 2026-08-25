import XCTest
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
    XCTAssertTrue(AlyteLocalModelManifest.artifactURL.contains("/resolve/(AlyteLocalModelManifest.artifactRevision)/"))
    XCTAssertFalse(AlyteLocalModelManifest.artifactURL.contains("/main/"))
  }

  func testRedirectPolicyRejectsUnreviewedHostsAndCredentials() {
    XCTAssertTrue(AlyteLocalModelManifest.isAllowedRedirect(URL(string: "https://cdn-lfs.huggingface.co/file")!))
    XCTAssertFalse(AlyteLocalModelManifest.isAllowedRedirect(URL(string: "http://cdn-lfs.huggingface.co/file")!))
    XCTAssertFalse(AlyteLocalModelManifest.isAllowedRedirect(URL(string: "https://example.com/file")!))
    XCTAssertFalse(AlyteLocalModelManifest.isAllowedRedirect(URL(string: "https://user:pass@cdn-lfs.huggingface.co/file")!))
  }
}
