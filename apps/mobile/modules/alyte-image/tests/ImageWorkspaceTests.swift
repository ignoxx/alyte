import XCTest
import UIKit

@testable import AlyteImagePrivacy

final class ImageWorkspaceTests: XCTestCase {
  func testViewerSessionIsOpaqueAndReleasesDecodedImageOnClose() {
    let image = UIImage.workspaceTestImage(size: CGSize(width: 1200, height: 900))
    let sessionId = AlyteImageViewerSessionStore.shared.insert(image)

    XCTAssertEqual(
      AlyteImageViewerSessionStore.shared.image(for: sessionId)?.size,
      CGSize(width: 1200, height: 900))
    AlyteImageViewerSessionStore.shared.remove(sessionId)
    XCTAssertNil(AlyteImageViewerSessionStore.shared.image(for: sessionId))
  }

  func testWorkspaceCentersAspectFitImageAndArbitratesMoveResizeTargets() throws {
    let workspace = AlyteImageWorkspaceView(appContext: nil)
    workspace.frame = CGRect(x: 0, y: 0, width: 390, height: 720)
    workspace.layoutIfNeeded()
    workspace.configureImageForTesting(UIImage.workspaceTestImage(size: CGSize(width: 1920, height: 1440)))
    workspace.redactMode = true
    workspace.setRedactions([[
      "id": "region-1",
      "rect": ["x": 0.2, "y": 0.25, "width": 0.3, "height": 0.2],
    ]])
    workspace.selectRedactionForTesting("region-1")
    workspace.layoutIfNeeded()

    let layout = workspace.layoutSnapshotForTesting()
    XCTAssertEqual(layout.zoomScale, 0.203125, accuracy: 0.000001)
    XCTAssertEqual(layout.displayedSize.width, 390, accuracy: 0.000001)
    XCTAssertEqual(layout.displayedSize.height, 292.5, accuracy: 0.000001)
    XCTAssertEqual(layout.contentInset.top, 213.75, accuracy: 0.000001)
    XCTAssertEqual(layout.contentInset.left, 0, accuracy: 0.000001)
    // UIScrollView rounds the content offset to the simulator's pixel grid.
    XCTAssertEqual(layout.contentOffset.y, -layout.contentInset.top, accuracy: 0.1)

    let regionFrame = CGRect(x: 384, y: 360, width: 576, height: 288)
    let moveTarget = workspace.gestureTargetForTesting(at: regionFrame.midpoint)
    XCTAssertEqual(moveTarget, AlyteImageWorkspaceGesture(id: "region-1", kind: .move))

    let handleFrame = try XCTUnwrap(workspace.overlayElementFrameForTesting(
      id: "region-1", kind: .resize))
    let resizeTarget = workspace.gestureTargetForTesting(at: handleFrame.midpoint)
    XCTAssertEqual(resizeTarget, AlyteImageWorkspaceGesture(id: "region-1", kind: .resize))
    XCTAssertEqual(handleFrame.width * layout.zoomScale, 44, accuracy: 0.000001)

    XCTAssertNil(workspace.gestureTargetForTesting(at: CGPoint(x: 1_600, y: 1_100)))

    let movedAtHalfTranslation = try XCTUnwrap(workspace.manipulatedRectForTesting(
      id: "region-1", translation: CGPoint(x: 48, y: 36), kind: .move))
    let movedAtFullTranslation = try XCTUnwrap(workspace.manipulatedRectForTesting(
      id: "region-1", translation: CGPoint(x: 96, y: 72), kind: .move))
    XCTAssertEqual(movedAtHalfTranslation.minX, 0.225, accuracy: 0.000001)
    XCTAssertEqual(movedAtFullTranslation.minX, 0.25, accuracy: 0.000001)
    XCTAssertGreaterThan(movedAtFullTranslation.minX, movedAtHalfTranslation.minX)

    let resized = try XCTUnwrap(workspace.manipulatedRectForTesting(
      id: "region-1", translation: CGPoint(x: 96, y: 72), kind: .resize))
    XCTAssertEqual(resized.width, 0.35, accuracy: 0.000001)
    XCTAssertEqual(resized.height, 0.25, accuracy: 0.000001)
  }

  func testWorkspaceDefersSourceLayoutUntilMountedAndRecentersAfterRepeatedProps() throws {
    let sourceURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-workspace-\(UUID().uuidString).jpg")
    let image = UIImage.workspaceTestImage(size: CGSize(width: 640, height: 400))
    try XCTUnwrap(image.jpegData(compressionQuality: 1)).write(to: sourceURL)
    defer { try? FileManager.default.removeItem(at: sourceURL) }

    let workspace = AlyteImageWorkspaceView(appContext: nil)
    // Expo can deliver props while the native view still has a zero-sized frame.
    workspace.sourcePath = sourceURL.path
    workspace.redactMode = true
    workspace.setRedactions([[
      "id": "existing-redaction",
      "rect": ["x": 0.64, "y": 0.18, "width": 0.18, "height": 0.08],
    ]])
    workspace.setFocusRegion(nil)
    workspace.layoutIfNeeded()

    workspace.frame = CGRect(x: 0, y: 0, width: 365, height: 580)
    workspace.layoutIfNeeded()
    // Repeated prop delivery during the first mounted layout must not move the image to a stale
    // zero-bounds zoom state or apply a second content inset on top of the first one.
    workspace.sourcePath = sourceURL.path
    workspace.redactMode = true
    workspace.setRedactions([[
      "id": "existing-redaction",
      "rect": ["x": 0.64, "y": 0.18, "width": 0.18, "height": 0.08],
    ]])
    workspace.setFocusRegion(nil)
    workspace.layoutIfNeeded()

    let layout = workspace.layoutSnapshotForTesting()
    XCTAssertEqual(layout.zoomScale, 365.0 / 640.0, accuracy: 0.000001)
    XCTAssertEqual(layout.displayedSize.width, 365, accuracy: 0.000001)
    XCTAssertEqual(layout.displayedSize.height, 228.125, accuracy: 0.000001)
    XCTAssertEqual(layout.contentInset.top, (580 - 228.125) / 2, accuracy: 0.1)
    XCTAssertEqual(layout.contentInset.left, 0, accuracy: 0.1)
    XCTAssertEqual(layout.contentOffset.x, 0, accuracy: 0.1)
    XCTAssertEqual(layout.contentOffset.y, -layout.contentInset.top, accuracy: 0.1)
  }

  func testWorkspacePanActionMovesAndResizesAndEmitsUndoableChanges() throws {
    let workspace = AlyteImageWorkspaceView(appContext: nil)
    workspace.frame = CGRect(x: 0, y: 0, width: 390, height: 720)
    workspace.layoutIfNeeded()
    workspace.configureImageForTesting(UIImage.workspaceTestImage(size: CGSize(width: 1920, height: 1440)))
    workspace.redactMode = true
    workspace.setRedactions([[
      "id": "region-1",
      "rect": ["x": 0.2, "y": 0.25, "width": 0.3, "height": 0.2],
    ]])
    workspace.selectRedactionForTesting("region-1")
    workspace.layoutIfNeeded()

    XCTAssertFalse(workspace.canUndoForTesting())
    let regionFrame = CGRect(x: 384, y: 360, width: 576, height: 288)
    let movePan = WorkspaceTestPanGestureRecognizer()
    let moveTarget = try XCTUnwrap(workspace.beginOverlayGestureForTesting(at: regionFrame.midpoint))
    XCTAssertEqual(moveTarget, AlyteImageWorkspaceGesture(id: "region-1", kind: .move))
    movePan.name = moveTarget.id
    movePan.testState = .began
    workspace.overlayPannedForTesting(movePan)
    movePan.testState = .changed
    movePan.testTranslation = CGPoint(x: 48, y: 36)
    workspace.overlayPannedForTesting(movePan)
    let movedAtHalfTranslation = try XCTUnwrap(workspace.redactionsForTesting().first?.rect)
    // A selection-triggered React render can send the pre-gesture recipe while the native pan is
    // active. It must be deferred and must not replace the live geometry on commit.
    workspace.setRedactions([[
      "id": "region-1",
      "rect": ["x": 0.2, "y": 0.25, "width": 0.3, "height": 0.2],
    ]])
    movePan.testTranslation = CGPoint(x: 96, y: 72)
    workspace.overlayPannedForTesting(movePan)
    let movedAtFullTranslation = try XCTUnwrap(workspace.redactionsForTesting().first?.rect)
    XCTAssertGreaterThan(movedAtFullTranslation.minX, movedAtHalfTranslation.minX)
    XCTAssertGreaterThan(movedAtFullTranslation.minY, movedAtHalfTranslation.minY)
    movePan.testState = .ended
    workspace.overlayPannedForTesting(movePan)

    XCTAssertTrue(workspace.canUndoForTesting())
    XCTAssertEqual(workspace.lastEmittedRedactionsForTesting().first?.rect, movedAtFullTranslation)

    let handleFrame = try XCTUnwrap(workspace.overlayElementFrameForTesting(
      id: "region-1", kind: .resize))
    let resizePan = WorkspaceTestPanGestureRecognizer()
    let resizeTarget = try XCTUnwrap(workspace.beginOverlayGestureForTesting(at: handleFrame.midpoint))
    XCTAssertEqual(resizeTarget, AlyteImageWorkspaceGesture(id: "region-1", kind: .resize))
    resizePan.name = resizeTarget.id
    resizePan.testState = .began
    workspace.overlayPannedForTesting(resizePan)
    resizePan.testState = .changed
    resizePan.testTranslation = CGPoint(x: 96, y: 72)
    workspace.overlayPannedForTesting(resizePan)
    let resized = try XCTUnwrap(workspace.redactionsForTesting().first?.rect)
    XCTAssertGreaterThan(resized.width, movedAtFullTranslation.width)
    XCTAssertGreaterThan(resized.height, movedAtFullTranslation.height)
    resizePan.testState = .ended
    workspace.overlayPannedForTesting(resizePan)
    XCTAssertEqual(workspace.lastEmittedRedactionsForTesting().first?.rect, resized)
  }
}

private final class WorkspaceTestPanGestureRecognizer: UIPanGestureRecognizer {
  var testState: UIGestureRecognizer.State = .possible
  var testTranslation = CGPoint.zero

  override var state: UIGestureRecognizer.State {
    get { testState }
    set { testState = newValue }
  }

  override func translation(in view: UIView?) -> CGPoint { testTranslation }
}

private extension CGRect {
  var midpoint: CGPoint { CGPoint(x: midX, y: midY) }
}

private extension UIImage {
  static func workspaceTestImage(size: CGSize) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { context in
      UIColor.systemRed.setFill()
      context.fill(CGRect(origin: .zero, size: size))
    }
  }
}
