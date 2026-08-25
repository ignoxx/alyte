import CoreGraphics

public struct AlyteImageWorkspaceInsets: Equatable {
  public let top: CGFloat
  public let left: CGFloat
  public let bottom: CGFloat
  public let right: CGFloat

  public init(top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat) {
    self.top = top
    self.left = left
    self.bottom = bottom
    self.right = right
  }
}

public struct AlyteImageWorkspaceViewport: Equatable {
  public let scale: CGFloat
  public let displayedSize: CGSize
  public let insets: AlyteImageWorkspaceInsets

  public init(scale: CGFloat, displayedSize: CGSize, insets: AlyteImageWorkspaceInsets) {
    self.scale = scale
    self.displayedSize = displayedSize
    self.insets = insets
  }
}

public enum AlyteImageWorkspaceGestureKind: Equatable {
  case move
  case resize
}

public struct AlyteImageWorkspaceGesture: Equatable {
  public let id: String
  public let kind: AlyteImageWorkspaceGestureKind

  public init(id: String, kind: AlyteImageWorkspaceGestureKind) {
    self.id = id
    self.kind = kind
  }
}

public struct AlyteImageWorkspaceInteractionState {
  public private(set) var inspectionMode: Bool
  public private(set) var selectedID: String?
  public private(set) var activeGesture: AlyteImageWorkspaceGesture?

  public init(inspectionMode: Bool = false, selectedID: String? = nil) {
    self.inspectionMode = inspectionMode
    self.selectedID = inspectionMode ? nil : selectedID
    self.activeGesture = nil
  }

  public var allowsMutation: Bool { !inspectionMode }

  public mutating func setInspectionMode(_ enabled: Bool) {
    inspectionMode = enabled
    if enabled {
      selectedID = nil
      activeGesture = nil
    }
  }

  public mutating func select(_ id: String?) {
    selectedID = inspectionMode ? nil : id
  }

  @discardableResult
  public mutating func beginGesture(id: String, kind: AlyteImageWorkspaceGestureKind) -> Bool {
    guard allowsMutation else { return false }
    activeGesture = AlyteImageWorkspaceGesture(id: id, kind: kind)
    return true
  }

  public mutating func endGesture() {
    activeGesture = nil
  }
}

public enum AlyteImageWorkspaceGeometry {
  public static let minimumViewSize: CGFloat = 24

  public static func aspectFit(imageSize: CGSize, viewportSize: CGSize) -> AlyteImageWorkspaceViewport {
    guard imageSize.width > 0, imageSize.height > 0, viewportSize.width > 0, viewportSize.height > 0 else {
      return AlyteImageWorkspaceViewport(
        scale: 0,
        displayedSize: .zero,
        insets: AlyteImageWorkspaceInsets(top: 0, left: 0, bottom: 0, right: 0))
    }
    let scale = min(viewportSize.width / imageSize.width, viewportSize.height / imageSize.height)
    let displayedSize = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
    return AlyteImageWorkspaceViewport(
      scale: scale,
      displayedSize: displayedSize,
      insets: AlyteImageWorkspaceInsets(
        top: max(0, (viewportSize.height - displayedSize.height) / 2),
        left: max(0, (viewportSize.width - displayedSize.width) / 2),
        bottom: max(0, (viewportSize.height - displayedSize.height) / 2),
        right: max(0, (viewportSize.width - displayedSize.width) / 2)))
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

  public static func focusRect(normalized rect: CGRect) -> CGRect {
    let marginX = max(rect.width, 0.08)
    let marginY = max(rect.height * 2, 0.08)
    return rect.insetBy(dx: -marginX, dy: -marginY)
      .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
  }

  public static func rotated(_ rect: CGRect, degrees: Int) -> CGRect {
    switch ((degrees % 360) + 360) % 360 {
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
        height: max(minimumHeight, min(1 - original.minY, original.height + dy)))
    }
    return CGRect(
      x: max(0, min(1 - original.width, original.minX + dx)),
      y: max(0, min(1 - original.height, original.minY + dy)),
      width: original.width,
      height: original.height)
  }
}
