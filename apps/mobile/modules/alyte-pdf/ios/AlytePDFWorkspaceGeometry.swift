import CoreGraphics

public enum AlytePDFWorkspaceGeometry {
  public static func viewRect(normalized: CGRect, pageFrame: CGRect) -> CGRect {
    CGRect(x: pageFrame.minX + normalized.minX * pageFrame.width,
           y: pageFrame.minY + normalized.minY * pageFrame.height,
           width: normalized.width * pageFrame.width,
           height: normalized.height * pageFrame.height)
  }

  public static func normalizedRect(viewRect: CGRect, pageFrame: CGRect) -> CGRect {
    CGRect(x: (viewRect.minX - pageFrame.minX) / pageFrame.width,
           y: (viewRect.minY - pageFrame.minY) / pageFrame.height,
           width: viewRect.width / pageFrame.width,
           height: viewRect.height / pageFrame.height)
  }

  public static func rotated(_ rect: CGRect, degrees: Int) -> CGRect {
    switch degrees {
    case 90: return CGRect(x: 1 - rect.maxY, y: rect.minX, width: rect.height, height: rect.width)
    case 180: return CGRect(x: 1 - rect.maxX, y: 1 - rect.maxY, width: rect.width, height: rect.height)
    case 270: return CGRect(x: rect.minY, y: 1 - rect.maxX, width: rect.height, height: rect.width)
    default: return rect
    }
  }
}
