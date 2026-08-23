import CoreGraphics

public enum AlytePDFWorkspaceGeometry {
  public static let minimumViewSize: CGFloat = 24

  public static func viewRect(normalized: CGRect, pageFrame: CGRect) -> CGRect {
    CGRect(
      x: pageFrame.minX + normalized.minX * pageFrame.width,
      y: pageFrame.minY + normalized.minY * pageFrame.height,
      width: normalized.width * pageFrame.width,
      height: normalized.height * pageFrame.height)
  }

  public static func normalizedRect(viewRect: CGRect, pageFrame: CGRect) -> CGRect {
    CGRect(
      x: (viewRect.minX - pageFrame.minX) / pageFrame.width,
      y: (viewRect.minY - pageFrame.minY) / pageFrame.height,
      width: viewRect.width / pageFrame.width,
      height: viewRect.height / pageFrame.height)
  }

  public static func rotated(_ rect: CGRect, degrees: Int) -> CGRect {
    switch degrees {
    case 90: return CGRect(x: 1 - rect.maxY, y: rect.minX, width: rect.height, height: rect.width)
    case 180:
      return CGRect(x: 1 - rect.maxX, y: 1 - rect.maxY, width: rect.width, height: rect.height)
    case 270: return CGRect(x: rect.minY, y: 1 - rect.maxX, width: rect.height, height: rect.width)
    default: return rect
    }
  }

  public static func manipulated(
    original: CGRect,
    translation: CGPoint,
    pageFrame: CGRect,
    rotation: Int = 0,
    resize: Bool,
    minimumViewSize: CGFloat = minimumViewSize
  ) -> CGRect {
    guard pageFrame.width > 0, pageFrame.height > 0 else { return original }
    let displayOriginal = rotated(original, degrees: rotation)
    let dx = translation.x / pageFrame.width
    let dy = translation.y / pageFrame.height
    let displayResult: CGRect
    if resize {
      let minimumWidth = min(1, minimumViewSize / pageFrame.width)
      let minimumHeight = min(1, minimumViewSize / pageFrame.height)
      displayResult = CGRect(
        x: displayOriginal.minX,
        y: displayOriginal.minY,
        width: max(minimumWidth, min(1 - displayOriginal.minX, displayOriginal.width + dx)),
        height: max(minimumHeight, min(1 - displayOriginal.minY, displayOriginal.height + dy))
      )
    } else {
      displayResult = CGRect(
        x: max(0, min(1 - displayOriginal.width, displayOriginal.minX + dx)),
        y: max(0, min(1 - displayOriginal.height, displayOriginal.minY + dy)),
        width: displayOriginal.width,
        height: displayOriginal.height
      )
    }
    return rotated(displayResult, degrees: (360 - rotation) % 360)
  }

  public static func reconciledSelection(_ selectedID: String?, regionIDs: [String]) -> String? {
    guard let selectedID else { return nil }
    return regionIDs.contains(selectedID) ? selectedID : nil
  }

  public static func selectionBridgeUpdate(
    current: String?, requested: String?, regionIDs: [String]
  ) -> (selectedID: String?, shouldEmit: Bool, isSelected: Bool) {
    let selectedID = reconciledSelection(requested, regionIDs: regionIDs)
    return (selectedID, selectedID != current, selectedID != nil)
  }
}

/// Testable state machine for the UIKit recognizer lifecycle. Controlled React props are deferred
/// while UIKit owns an active finger session, then the locally committed value remains authoritative.
public struct AlytePDFWorkspaceGestureSession {
  public private(set) var regions: [String: CGRect]
  public private(set) var activeID: String?
  public private(set) var commitCount = 0
  private var original: CGRect?
  private var deferredControlledRegions: [String: CGRect]?

  public init(regions: [String: CGRect]) { self.regions = regions }

  public mutating func begin(id: String) {
    guard let rect = regions[id] else { return }
    activeID = id
    original = rect
    deferredControlledRegions = nil
  }

  public mutating func change(
    translation: CGPoint, pageFrame: CGRect, rotation: Int = 0, resize: Bool
  ) {
    guard let id = activeID, let original else { return }
    regions[id] = AlytePDFWorkspaceGeometry.manipulated(
      original: original, translation: translation, pageFrame: pageFrame, rotation: rotation,
      resize: resize)
  }

  public mutating func receiveControlled(_ next: [String: CGRect]) {
    if activeID == nil { regions = next } else { deferredControlledRegions = next }
  }

  @discardableResult
  public mutating func end(cancelled: Bool) -> [String: CGRect] {
    if cancelled, let id = activeID, let original {
      regions[id] = original
    } else if let id = activeID, let original, regions[id] != original {
      commitCount += 1
    }
    let result = regions
    activeID = nil
    original = nil
    if cancelled, let deferredControlledRegions { regions = deferredControlledRegions }
    self.deferredControlledRegions = nil
    return cancelled ? regions : result
  }
}
