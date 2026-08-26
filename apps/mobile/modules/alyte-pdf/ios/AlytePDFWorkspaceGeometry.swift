import CoreGraphics

public enum AlytePDFWorkspaceGestureKind: Equatable {
  case move
  case resize
}

public struct AlytePDFWorkspaceGesture: Equatable {
  public let id: String
  public let kind: AlytePDFWorkspaceGestureKind

  public init(id: String, kind: AlytePDFWorkspaceGestureKind) {
    self.id = id
    self.kind = kind
  }
}

/// A displayed overlay frame used to keep touch routing independent from PDFKit's coordinate
/// conversion. The view supplies frames in its own bounds; this pure helper decides which edit
/// target, if any, owns a touch.
public struct AlytePDFWorkspaceOverlayFrame: Equatable {
  public let id: String
  public let frame: CGRect
  public let kind: AlytePDFWorkspaceGestureKind

  public init(id: String, frame: CGRect, kind: AlytePDFWorkspaceGestureKind) {
    self.id = id
    self.frame = frame
    self.kind = kind
  }
}

public struct AlytePDFWorkspaceGestureResult: Equatable {
  public let rect: CGRect
  public let shouldRecordUndo: Bool
  public let cancelled: Bool

  public init(rect: CGRect, shouldRecordUndo: Bool, cancelled: Bool) {
    self.rect = rect
    self.shouldRecordUndo = shouldRecordUndo
    self.cancelled = cancelled
  }
}

/// Production gesture lifecycle shared by the UIKit view and native geometry checks. The view
/// owns the surrounding recipe/history arrays; this primitive owns only the frozen rect and the
/// terminal decision so cancellation cannot accidentally become an undoable edit.
public struct AlytePDFWorkspaceGestureLifecycle: Equatable {
  public private(set) var isActive = false
  private var original: CGRect?
  private var current: CGRect?

  public init() {}

  public mutating func begin(original: CGRect) {
    self.original = original
    current = original
    isActive = true
  }

  public mutating func update(_ rect: CGRect) {
    guard isActive else { return }
    current = rect
  }

  @discardableResult
  public mutating func finish(cancelled: Bool) -> AlytePDFWorkspaceGestureResult? {
    guard isActive, let original else { return nil }
    let current = current ?? original
    let result = AlytePDFWorkspaceGestureResult(
      rect: cancelled ? original : current,
      shouldRecordUndo: !cancelled && current != original,
      cancelled: cancelled)
    self.original = nil
    self.current = nil
    isActive = false
    return result
  }
}

public enum AlytePDFWorkspaceGeometry {
  public static let minimumViewSize: CGFloat = 24
  public static let minimumHitTarget: CGFloat = 44
  public static let editGestureMinimumTouches = 1
  public static let editGestureMaximumTouches = 1

  /// Existing redactions remain selectable/editable when the Redact mode button is off. Only
  /// inspection mode makes the overlay read-only; blank-space creation is gated separately by
  /// `canCreateRedaction` so PDFKit keeps ownership of native navigation everywhere else.
  public static func overlayInteractionEnabled(inspectionMode: Bool) -> Bool {
    !inspectionMode
  }

  public static func canCreateRedaction(redactMode: Bool, inspectionMode: Bool) -> Bool {
    redactMode && !inspectionMode
  }

  /// Selects resize handles first, then redaction bodies with a minimum touch target. Returning
  /// nil for blank space is intentional: the stable overlay recognizer fails there, allowing the
  /// native PDFKit pan and pinch recognizers to own the touch.
  public static func gestureTarget(
    at point: CGPoint,
    overlayFrames: [AlytePDFWorkspaceOverlayFrame],
    minimumHitTarget: CGFloat = AlytePDFWorkspaceGeometry.minimumHitTarget
  ) -> AlytePDFWorkspaceGesture? {
    let handles = overlayFrames.filter { $0.kind == .resize }
    let regions = overlayFrames.filter { $0.kind == .move }

    for handle in handles where handle.frame.contains(point) {
      return AlytePDFWorkspaceGesture(id: handle.id, kind: .resize)
    }

    for region in regions.reversed() {
      let horizontalSlop = max(8, (minimumHitTarget - region.frame.width) / 2)
      let verticalSlop = max(8, (minimumHitTarget - region.frame.height) / 2)
      if region.frame.insetBy(dx: -horizontalSlop, dy: -verticalSlop).contains(point) {
        return AlytePDFWorkspaceGesture(id: region.id, kind: .move)
      }
    }
    return nil
  }

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

  public static func focusRect(normalized rect: CGRect) -> CGRect {
    let marginX = max(rect.width, 0.08)
    let marginY = max(rect.height * 2, 0.08)
    return rect.insetBy(dx: -marginX, dy: -marginY)
      .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
  }
}
