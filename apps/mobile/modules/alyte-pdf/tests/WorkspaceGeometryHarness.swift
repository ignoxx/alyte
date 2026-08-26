import CoreGraphics

@main
enum WorkspaceGeometryHarness {
  static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.minX - rhs.minX) < 0.000_001 && abs(lhs.minY - rhs.minY) < 0.000_001
      && abs(lhs.width - rhs.width) < 0.000_001 && abs(lhs.height - rhs.height) < 0.000_001
  }

  static func main() {
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
    var move = AlytePDFWorkspaceGestureSession(regions: ["region": source])
    move.begin(id: "region")
    move.change(translation: CGPoint(x: 48, y: 72), pageFrame: page, resize: false)
    move.change(translation: CGPoint(x: 144, y: 216), pageFrame: page, resize: false)
    move.receiveControlled(["region": source])
    let moved = move.end(cancelled: false)["region"]!
    precondition(approximatelyEqual(moved, CGRect(x: 0.27, y: 0.49, width: 0.46, height: 0.08)))
    precondition(move.commitCount == 1)

    let gestureSource = CGRect(x: 0.2, y: 0.25, width: 0.2, height: 0.1)
    for rotation in [0, 90, 180, 270] {
      let displayedSource = AlytePDFWorkspaceGeometry.rotated(gestureSource, degrees: rotation)
      var rotatedMove = AlytePDFWorkspaceGestureSession(regions: ["region": gestureSource])
      rotatedMove.begin(id: "region")
      rotatedMove.change(
        translation: CGPoint(x: 20, y: 30),
        pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600), rotation: rotation, resize: false)
      rotatedMove.change(
        translation: CGPoint(x: 40, y: 60),
        pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600), rotation: rotation, resize: false)
      let displayedMove = AlytePDFWorkspaceGeometry.rotated(
        rotatedMove.end(cancelled: false)["region"]!, degrees: rotation)
      precondition(
        approximatelyEqual(
          displayedMove,
          CGRect(
            x: displayedSource.minX + 0.1, y: displayedSource.minY + 0.1,
            width: displayedSource.width, height: displayedSource.height)))
      precondition(rotatedMove.commitCount == 1)

      var rotatedResize = AlytePDFWorkspaceGestureSession(regions: ["region": gestureSource])
      rotatedResize.begin(id: "region")
      rotatedResize.change(
        translation: CGPoint(x: 20, y: 30),
        pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600), rotation: rotation, resize: true)
      rotatedResize.change(
        translation: CGPoint(x: 40, y: 60),
        pageFrame: CGRect(x: 20, y: 40, width: 400, height: 600), rotation: rotation, resize: true)
      let displayedResize = AlytePDFWorkspaceGeometry.rotated(
        rotatedResize.end(cancelled: false)["region"]!, degrees: rotation)
      precondition(
        approximatelyEqual(
          displayedResize,
          CGRect(
            x: displayedSource.minX, y: displayedSource.minY, width: displayedSource.width + 0.1,
            height: displayedSource.height + 0.1)))
      precondition(rotatedResize.commitCount == 1)
    }

    var resize = AlytePDFWorkspaceGestureSession(regions: [
      "region": CGRect(x: 0.9, y: 0.9, width: 0.08, height: 0.08)
    ])
    resize.begin(id: "region")
    resize.change(translation: CGPoint(x: 500, y: 500), pageFrame: page, resize: true)
    let grown = resize.end(cancelled: false)["region"]!
    precondition(approximatelyEqual(grown, CGRect(x: 0.9, y: 0.9, width: 0.1, height: 0.1)))

    var minimum = AlytePDFWorkspaceGestureSession(regions: [
      "region": CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3)
    ])
    minimum.begin(id: "region")
    minimum.change(translation: CGPoint(x: -1000, y: -1000), pageFrame: page, resize: true)
    let shrunk = minimum.end(cancelled: false)["region"]!
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
