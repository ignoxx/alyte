import CoreGraphics

@main
enum WorkspaceGeometryHarness {
  static func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.minX - rhs.minX) < 0.000_001 && abs(lhs.minY - rhs.minY) < 0.000_001 &&
      abs(lhs.width - rhs.width) < 0.000_001 && abs(lhs.height - rhs.height) < 0.000_001
  }

  static func main() {
    let source = CGRect(x: 0.12, y: 0.34, width: 0.46, height: 0.08)
    for frame in [
      CGRect(x: 40, y: 100, width: 320, height: 480),
      CGRect(x: -180, y: -240, width: 960, height: 1440),
      CGRect(x: -900, y: 20, width: 1920, height: 2880),
    ] {
      let view = AlytePDFWorkspaceGeometry.viewRect(normalized: source, pageFrame: frame)
      precondition(approximatelyEqual(AlytePDFWorkspaceGeometry.normalizedRect(viewRect: view, pageFrame: frame), source))
    }
    for rotation in [0, 90, 180, 270] {
      let transformed = AlytePDFWorkspaceGeometry.rotated(source, degrees: rotation)
      let restored = AlytePDFWorkspaceGeometry.rotated(transformed, degrees: (360 - rotation) % 360)
      precondition(approximatelyEqual(restored, source))
    }

    let page = CGRect(x: -180, y: -240, width: 960, height: 1440)
    var move = AlytePDFWorkspaceGestureSession(regions: ["region": source])
    move.begin(id: "region")
    move.change(translation: CGPoint(x: 48, y: 72), pageFrame: page, resize: false)
    move.change(translation: CGPoint(x: 144, y: 216), pageFrame: page, resize: false)
    move.receiveControlled(["region": source])
    let moved = move.end(cancelled: false)["region"]!
    precondition(approximatelyEqual(moved, CGRect(x: 0.27, y: 0.49, width: 0.46, height: 0.08)))

    var resize = AlytePDFWorkspaceGestureSession(regions: ["region": CGRect(x: 0.9, y: 0.9, width: 0.08, height: 0.08)])
    resize.begin(id: "region")
    resize.change(translation: CGPoint(x: 500, y: 500), pageFrame: page, resize: true)
    let grown = resize.end(cancelled: false)["region"]!
    precondition(approximatelyEqual(grown, CGRect(x: 0.9, y: 0.9, width: 0.1, height: 0.1)))

    var minimum = AlytePDFWorkspaceGestureSession(regions: ["region": CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3)])
    minimum.begin(id: "region")
    minimum.change(translation: CGPoint(x: -1000, y: -1000), pageFrame: page, resize: true)
    let shrunk = minimum.end(cancelled: false)["region"]!
    precondition(abs(shrunk.width - 0.025) < 0.000_001)
    precondition(abs(shrunk.height - (24 / 1440)) < 0.000_001)
    print("PDFKit workspace geometry checks passed")
  }
}
