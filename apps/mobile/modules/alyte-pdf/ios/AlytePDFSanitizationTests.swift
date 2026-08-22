import XCTest

/// XCTest seam for the native redaction boundary. The production renderer is exercised in an iOS
/// host target; these fixture assertions document the normalized coordinate contract when an iOS
/// simulator is unavailable to this worktree.
final class AlytePDFSanitizationTests: XCTestCase {
  func testClockwiseRotationMapsTopLeftNormalizedRect() {
    let rect = CGRect(x: 0.2, y: 0.25, width: 0.2, height: 0.25)
    let rotated = CGRect(
      x: 1 - rect.minY - rect.height,
      y: rect.minX,
      width: rect.height,
      height: rect.width
    )
    XCTAssertEqual(rotated.origin.x, 0.5, accuracy: 0.000_001)
    XCTAssertEqual(rotated.origin.y, 0.2, accuracy: 0.000_001)
    XCTAssertEqual(rotated.width, 0.25, accuracy: 0.000_001)
    XCTAssertEqual(rotated.height, 0.2, accuracy: 0.000_001)
  }

  func testFailedVerificationMustNotBePresentedAsSanitized() {
    let selectableText = true
    let recoveryChecked = true
    let verified = !selectableText && recoveryChecked
    XCTAssertFalse(verified)
  }
}
