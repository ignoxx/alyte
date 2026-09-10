import XCTest
import Foundation
@testable import AlyteLocalModels

final class AlyteLocalModelsModuleTests: XCTestCase {
  func testManifestPinsTheReviewedArtifactAndRuntime() {
    XCTAssertEqual(AlyteLocalModelManifest.packID, "paddleocr-vl-1.6-q8")
    XCTAssertEqual(AlyteLocalModelManifest.bytes, 1_380_086_816)
    XCTAssertEqual(AlyteLocalModelManifest.artifactBytes, 498_316_256)
    XCTAssertEqual(AlyteLocalModelManifest.projectorBytes, 881_770_560)
    XCTAssertEqual(
      AlyteLocalModelManifest.sha256,
      "2bda93a416339f2d9f06accae505600544a9e72cc159d0cd1af4c0f679866e1c"
    )
    XCTAssertEqual(
      AlyteLocalModelManifest.projectorSha256,
      "204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a"
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

  func testRawOCREntrypointIsSeparateFromStructuredInference() {
    XCTAssertNotEqual(
      AlyteLocalModelManifest.promptBundle,
      "alyte.document-vlm.prompt.v1"
    )
    XCTAssertEqual(AlyteLocalModelManifest.promptBundle, "alyte.document-ocr.raw.v1")
  }

  func testRuntimeCancellationPreservesTypedStoreFailure() {
    let error = AlyteLocalModelStore.localModelError(from: AlyteLocalModelRuntimeError.cancelled)
    XCTAssertEqual(error.failure.rawValue, AlyteLocalModelFailure.cancelled.rawValue)
  }
}
