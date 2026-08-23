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
    print("PDFKit workspace geometry checks passed")
  }
}
