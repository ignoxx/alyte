import CoreGraphics

public enum AlytePDFWorkspaceGeometry {
  public static let minimumViewSize: CGFloat = 24

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

  public static func manipulated(
    original: CGRect,
    translation: CGPoint,
    pageFrame: CGRect,
    resize: Bool,
    minimumViewSize: CGFloat = minimumViewSize
  ) -> CGRect {
    guard pageFrame.width > 0, pageFrame.height > 0 else { return original }
    let dx = translation.x / pageFrame.width
    let dy = translation.y / pageFrame.height
    if resize {
      let minimumWidth = min(1, minimumViewSize / pageFrame.width)
      let minimumHeight = min(1, minimumViewSize / pageFrame.height)
      return CGRect(
        x: original.minX,
        y: original.minY,
        width: max(minimumWidth, min(1 - original.minX, original.width + dx)),
        height: max(minimumHeight, min(1 - original.minY, original.height + dy))
      )
    }
    return CGRect(
      x: max(0, min(1 - original.width, original.minX + dx)),
      y: max(0, min(1 - original.height, original.minY + dy)),
      width: original.width,
      height: original.height
    )
  }
}

/// Testable state machine for the UIKit recognizer lifecycle. Controlled React props are deferred
/// while UIKit owns an active finger session, then the locally committed value remains authoritative.
public struct AlytePDFWorkspaceGestureSession {
  public private(set) var regions: [String: CGRect]
  public private(set) var activeID: String?
  private var original: CGRect?
  private var deferredControlledRegions: [String: CGRect]?

  public init(regions: [String: CGRect]) { self.regions = regions }

  public mutating func begin(id: String) {
    guard let rect = regions[id] else { return }
    activeID = id
    original = rect
    deferredControlledRegions = nil
  }

  public mutating func change(translation: CGPoint, pageFrame: CGRect, resize: Bool) {
    guard let id = activeID, let original else { return }
    regions[id] = AlytePDFWorkspaceGeometry.manipulated(
      original: original, translation: translation, pageFrame: pageFrame, resize: resize)
  }

  public mutating func receiveControlled(_ next: [String: CGRect]) {
    if activeID == nil { regions = next } else { deferredControlledRegions = next }
  }

  @discardableResult
  public mutating func end(cancelled: Bool) -> [String: CGRect] {
    if cancelled, let id = activeID, let original { regions[id] = original }
    let result = regions
    activeID = nil
    original = nil
    if cancelled, let deferredControlledRegions { regions = deferredControlledRegions }
    self.deferredControlledRegions = nil
    return cancelled ? regions : result
  }
}
