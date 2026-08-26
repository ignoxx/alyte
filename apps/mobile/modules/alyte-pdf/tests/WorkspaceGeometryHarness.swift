import CoreGraphics

@main
enum WorkspaceGeometryHarness {
  static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.minX - rhs.minX) < 0.000_001 && abs(lhs.minY - rhs.minY) < 0.000_001
      && abs(lhs.width - rhs.width) < 0.000_001 && abs(lhs.height - rhs.height) < 0.000_001
  }

  static func main() {
    precondition(AlytePDFWorkspaceGeometry.editGestureMinimumTouches == 1)
    precondition(AlytePDFWorkspaceGeometry.editGestureMaximumTouches == 1)

    let original = CGRect(x: 0.1, y: 0.1, width: 0.2, height: 0.2)
    var cancelledGesture = AlytePDFWorkspaceGestureLifecycle()
    cancelledGesture.begin(original: original)
    cancelledGesture.update(CGRect(x: 0.3, y: 0.3, width: 0.2, height: 0.2))
    precondition(
      cancelledGesture.finish(cancelled: true)
        == AlytePDFWorkspaceGestureResult(
          rect: original, shouldRecordUndo: false, cancelled: true))

    var committedGesture = AlytePDFWorkspaceGestureLifecycle()
    committedGesture.begin(original: original)
    for step in 1...12 {
      committedGesture.update(CGRect(
        x: original.minX + CGFloat(step) * 0.01,
        y: original.minY + CGFloat(step) * 0.01,
        width: original.width,
        height: original.height))
    }
    guard let committed = committedGesture.finish(cancelled: false) else {
      fatalError("The active gesture should commit")
    }
    precondition(
      abs(committed.rect.minX - 0.22) < 0.000_001
        && abs(committed.rect.minY - 0.22) < 0.000_001)
    precondition(committed.shouldRecordUndo)
    precondition(committedGesture.finish(cancelled: false) == nil)

    let source = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    for frame in [
      CGRect(x: 40, y: 100, width: 320, height: 480),
      CGRect(x: -180, y: -240, width: 960, height: 1440),
      CGRect(x: -900, y: 20, width: 1920, height: 2880),
    ] {
      let view = AlytePDFWorkspaceGeometry.viewRect(normalized: source, pageFrame: frame)
      precondition(
        approximatelyEqual(
          AlytePDFWorkspaceGeometry.normalizedRect(viewRect: view, pageFrame: frame), source))
    }
    for rotation in [0, 90, 180, 270] {
      let transformed = AlytePDFWorkspaceGeometry.rotated(source, degrees: rotation)
      let restored = AlytePDFWorkspaceGeometry.rotated(transformed, degrees: (360 - rotation) % 360)
      precondition(approximatelyEqual(restored, source))
    }

    let body = AlytePDFWorkspaceOverlayFrame(
      id: "region", frame: CGRect(x: 100, y: 140, width: 160, height: 90), kind: .move)
    let handle = AlytePDFWorkspaceOverlayFrame(
      id: "region", frame: CGRect(x: 216, y: 186, width: 44, height: 44), kind: .resize)
    precondition(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 236, y: 206), overlayFrames: [body, handle])
        == AlytePDFWorkspaceGesture(id: "region", kind: .resize))
    precondition(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 160, y: 170), overlayFrames: [body, handle])
        == AlytePDFWorkspaceGesture(id: "region", kind: .move))
    precondition(
      AlytePDFWorkspaceGeometry.gestureTarget(
        at: CGPoint(x: 20, y: 20), overlayFrames: [body, handle]) == nil)

    let page = CGRect(x: -180, y: -240, width: 960, height: 1440)
    let firstMove = AlytePDFWorkspaceGeometry.manipulated(
      original: source, translation: CGPoint(x: 48, y: 72), pageFrame: page, resize: false)
    let moved = AlytePDFWorkspaceGeometry.manipulated(
      original: source, translation: CGPoint(x: 144, y: 216), pageFrame: page, resize: false)
    precondition(moved.minX > firstMove.minX && moved.minY > firstMove.minY)
    precondition(approximatelyEqual(moved, CGRect(x: 0.27, y: 0.49, width: 0.46, height: 0.08)))

    let gestureSource = CGRect(x: 0.2, y: 0.25, width: 0.2, height: 0.1)
    for rotation in [0, 90, 180, 270] {
      let displayedSource = AlytePDFWorkspaceGeometry.rotated(gestureSource, degrees: rotation)
      let firstDisplayedMove = AlytePDFWorkspaceGeometry.rotated(
        AlytePDFWorkspaceGeometry.manipulated(
          original: gestureSource,
          translation: CGPoint(x: 20, y: 30),
          pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600),
          rotation: rotation,
          resize: false),
        degrees: rotation)
      let displayedMove = AlytePDFWorkspaceGeometry.rotated(
        AlytePDFWorkspaceGeometry.manipulated(
          original: gestureSource,
          translation: CGPoint(x: 40, y: 60),
          pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600),
          rotation: rotation,
          resize: false),
        degrees: rotation)
      precondition(displayedMove.minX > firstDisplayedMove.minX)
      precondition(
        approximatelyEqual(
          displayedMove,
          CGRect(
            x: displayedSource.minX + 0.1, y: displayedSource.minY + 0.1,
            width: displayedSource.width, height: displayedSource.height)))

      let firstDisplayedResize = AlytePDFWorkspaceGeometry.rotated(
        AlytePDFWorkspaceGeometry.manipulated(
          original: gestureSource,
          translation: CGPoint(x: 20, y: 30),
          pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600),
          rotation: rotation,
          resize: true),
        degrees: rotation)
      let displayedResize = AlytePDFWorkspaceGeometry.rotated(
        AlytePDFWorkspaceGeometry.manipulated(
          original: gestureSource,
          translation: CGPoint(x: 40, y: 60),
          pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600),
          rotation: rotation,
          resize: true),
        degrees: rotation)
      precondition(displayedResize.width > firstDisplayedResize.width)
      precondition(
        approximatelyEqual(
          displayedResize,
          CGRect(
            x: displayedSource.minX, y: displayedSource.minY, width: displayedSource.width + 0.1,
            height: displayedSource.height + 0.1)))
    }

    let grown = AlytePDFWorkspaceGeometry.manipulated(
      original: CGRect(x: 0.9, y: 0.9, width: 0.08, height: 0.08),
      translation: CGPoint(x: 500, y: 500),
      pageFrame: page,
      resize: true)
    precondition(approximatelyEqual(grown, CGRect(x: 0.9, y: 0.9, width: 0.1, height: 0.1)))

    let shrunk = AlytePDFWorkspaceGeometry.manipulated(
      original: CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3),
      translation: CGPoint(x: -1000, y: -1000),
      pageFrame: page,
      resize: true)
    precondition(abs(shrunk.width - 0.025) < 0.000_001)
    precondition(abs(shrunk.height - (24 / 1440)) < 0.000_001)
    precondition(
      AlytePDFWorkspaceGeometry.reconciledSelection("region", regionIDs: ["replacement"]) == nil)
    let focused = AlytePDFWorkspaceGeometry.focusRect(
      normalized: CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.08))
    precondition(approximatelyEqual(focused, CGRect(x: 0, y: 0.04, width: 0.7, height: 0.4)))
    let cropped = CGRect(x: 0.0625, y: 0.142857142857, width: 0.375, height: 0.114285714286)
    precondition(
      approximatelyEqual(
        AlytePDFWorkspaceGeometry.rotated(cropped, degrees: 90),
        CGRect(x: 0.742857142857, y: 0.0625, width: 0.114285714286, height: 0.375)))
    print("PDFKit workspace geometry checks passed")
  }
}
