import UIKit

#if canImport(ExpoModulesCore)
import ExpoModulesCore
#else
final class AppContext {}

final class EventDispatcher {
  func callAsFunction(_ payload: [String: Any]) {}
}

class ExpoView: UIView {
  required init(appContext: AppContext? = nil) { super.init(frame: .zero) }
  required init?(coder: NSCoder) { super.init(coder: coder) }
}
#endif

private struct ImageWorkspaceRedaction: Equatable {
  let id: String
  var rect: CGRect
}

private enum ImageWorkspaceOverlayRole: Equatable {
  case redaction
  case resizeHandle

  var gestureKind: AlyteImageWorkspaceGestureKind {
    switch self {
    case .redaction: return .move
    case .resizeHandle: return .resize
    }
  }
}

private final class ImageRedactionOverlayElement: UIView {
  let role: ImageWorkspaceOverlayRole

  init(role: ImageWorkspaceOverlayRole, frame: CGRect) {
    self.role = role
    super.init(frame: frame)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

struct AlyteImageWorkspaceLayoutSnapshot {
  let zoomScale: CGFloat
  let displayedSize: CGSize
  let contentInset: AlyteImageWorkspaceInsets
  let contentOffset: CGPoint
}

private final class ImageRedactionOverlay: UIView {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    isUserInteractionEnabled && subviews.contains {
      !$0.isHidden && $0.alpha > 0 && $0.frame.insetBy(dx: -8, dy: -8).contains(point)
    } || isUserInteractionEnabled
  }
}

/// UIKit owns image decoding, aspect-fit zoom, and pan. React receives only normalized image
/// coordinates, so a source image's EXIF orientation or a scroll-view zoom never changes the
/// recipe's meaning.
final class AlyteImageWorkspaceView: ExpoView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  let onRedactionsChange = EventDispatcher()
  let onReady = EventDispatcher()
  let onFailure = EventDispatcher()
  let onSelectionChange = EventDispatcher()

  private let scrollView = UIScrollView()
  private let imageView = UIImageView()
  private let overlay = ImageRedactionOverlay()
  private let overlayPan = UIPanGestureRecognizer()
  private var image: UIImage?
  private var regions: [ImageWorkspaceRedaction] = []
  private var interactionState = AlyteImageWorkspaceInteractionState()
  private var history: [[ImageWorkspaceRedaction]] = []
  private var future: [[ImageWorkspaceRedaction]] = []
  private var startRegions: [ImageWorkspaceRedaction] = []
  private var labels: [String: String] = [:]
  private var deferredRegions: [ImageWorkspaceRedaction]?
  private var lastViewportSize = CGSize.zero
  private var focusRegion: CGRect?
  private var overlayGestureRole: ImageWorkspaceOverlayRole?

  private enum InteractionMetrics {
    static let minimumHitTarget: CGFloat = 44
    static let resizeKnobSize: CGFloat = 16
  }

  var sourcePath = "" { didSet { if oldValue != sourcePath { load() } } }
  var inspectionMode: Bool {
    get { interactionState.inspectionMode }
    set {
      guard interactionState.inspectionMode != newValue else { return }
      let hadSelection = selectedID != nil
      interactionState.setInspectionMode(newValue)
      if newValue {
        startRegions.removeAll()
        deferredRegions = nil
      }
      if hadSelection, newValue { onSelectionChange(["selected": false]) }
      updateOverlayInteraction()
      layoutRegions()
    }
  }
  var redactMode = false {
    didSet {
      updateOverlayInteraction()
      if !redactMode { clearSelection() }
    }
  }

  private var selectedID: String? { interactionState.selectedID }
  private var activeGestureID: String? { interactionState.activeGesture?.id }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .systemBackground
    scrollView.delegate = self
    scrollView.minimumZoomScale = 1
    scrollView.maximumZoomScale = 1
    scrollView.showsVerticalScrollIndicator = false
    scrollView.showsHorizontalScrollIndicator = false
    // The editor owns safe-area layout. Automatic adjustment would add a second inset and can
    // leave a landscape source offset against one edge on its first layout.
    scrollView.contentInsetAdjustmentBehavior = .never
    scrollView.backgroundColor = .systemBackground
    addSubview(scrollView)

    imageView.contentMode = .scaleToFill
    imageView.isUserInteractionEnabled = true
    scrollView.addSubview(imageView)
    overlay.backgroundColor = .clear
    overlay.isUserInteractionEnabled = false
    imageView.addSubview(overlay)

    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
    doubleTap.numberOfTapsRequired = 2
    doubleTap.delegate = self
    scrollView.addGestureRecognizer(doubleTap)
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    tap.require(toFail: doubleTap)
    overlay.addGestureRecognizer(tap)
    overlayPan.addTarget(self, action: #selector(overlayPanned(_:)))
    overlayPan.delegate = self
    // The single overlay recognizer can explicitly fail for empty space, allowing the scroll
    // view to pan there. Per-redaction recognizers cannot express that arbitration reliably when
    // the touch begins on the overlay itself.
    scrollView.panGestureRecognizer.require(toFail: overlayPan)
    overlay.addGestureRecognizer(overlayPan)
  }

#if !canImport(ExpoModulesCore)
  required init?(coder: NSCoder) { super.init(coder: coder) }
#endif

  private func updateOverlayInteraction() {
    overlay.isUserInteractionEnabled = redactMode && !inspectionMode
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scrollView.frame = bounds
    guard let image else { return }
    if imageView.bounds.size == .zero || imageView.image !== image || lastViewportSize != bounds.size {
      configureImage(image)
    }
    overlay.frame = imageView.bounds
    layoutRegions()
    centerImage()
  }

  func setRedactions(_ values: [[String: Any]]) {
    let next = values.compactMap { value -> ImageWorkspaceRedaction? in
      guard let id = value["id"] as? String, let rect = value["rect"] as? [String: Any],
        let x = (rect["x"] as? NSNumber)?.doubleValue,
        let y = (rect["y"] as? NSNumber)?.doubleValue,
        let width = (rect["width"] as? NSNumber)?.doubleValue,
        let height = (rect["height"] as? NSNumber)?.doubleValue
      else { return nil }
      return ImageWorkspaceRedaction(id: id, rect: CGRect(x: x, y: y, width: width, height: height))
    }
    guard next != regions else { return }
    if activeGestureID != nil {
      deferredRegions = next
      return
    }
    regions = next
    history.removeAll()
    future.removeAll()
    reconcileSelection()
    layoutRegions()
  }

  func setAccessibilityLabels(_ value: [String: String]) {
    labels = value
    layoutRegions()
  }

  func setFocusRegion(_ value: [String: Any]?) {
    guard let value,
      let x = (value["x"] as? NSNumber)?.doubleValue,
      let y = (value["y"] as? NSNumber)?.doubleValue,
      let width = (value["width"] as? NSNumber)?.doubleValue,
      let height = (value["height"] as? NSNumber)?.doubleValue
    else {
      focusRegion = nil
      return
    }
    focusRegion = CGRect(x: x, y: y, width: width, height: height)
    focusStoredRegion()
  }

  func undoEdit() {
    guard !inspectionMode else { return }
    guard let previous = history.popLast() else { return }
    future.append(regions)
    regions = previous
    reconcileSelection()
    emit()
    layoutRegions()
  }

  func redoEdit() {
    guard !inspectionMode else { return }
    guard let next = future.popLast() else { return }
    history.append(regions)
    regions = next
    reconcileSelection()
    emit()
    layoutRegions()
  }

  func clearSelection() {
    setSelection(nil)
    layoutRegions()
  }

  func removeSelected() {
    guard !inspectionMode else { return }
    guard let selectedID, regions.contains(where: { $0.id == selectedID }) else { return }
    history.append(regions)
    future.removeAll()
    regions.removeAll { $0.id == selectedID }
    setSelection(nil)
    emit()
    layoutRegions()
  }

  private func load() {
    guard !sourcePath.isEmpty,
      let data = try? Data(contentsOf: URL(fileURLWithPath: sourcePath)),
      let loaded = UIImage(data: data)
    else {
      onFailure(["message": "The image could not be opened in the privacy workspace"])
      return
    }
    image = loaded
    configureImage(loaded)
    onReady([
      "width": loaded.size.width,
      "height": loaded.size.height,
    ])
  }

  private func configureImage(_ image: UIImage) {
    self.image = image
    imageView.image = image
    imageView.frame = CGRect(origin: .zero, size: image.size)
    imageView.bounds = CGRect(origin: .zero, size: image.size)
    scrollView.contentSize = image.size
    let viewport = AlyteImageWorkspaceGeometry.aspectFit(
      imageSize: image.size, viewportSize: scrollView.bounds.size)
    let scale = max(0.01, viewport.scale)
    scrollView.minimumZoomScale = scale
    scrollView.maximumZoomScale = max(scale * 4, scale + 1)
    scrollView.setZoomScale(scale, animated: false)
    scrollView.layoutIfNeeded()
    lastViewportSize = scrollView.bounds.size
    overlay.frame = imageView.bounds
    layoutRegions()
    centerImage(
      displayedSize: viewport.displayedSize,
      insets: viewport.insets,
      resetContentOffset: true)
    focusStoredRegion()
  }

  private func centerImage(
    displayedSize: CGSize? = nil,
    insets: AlyteImageWorkspaceInsets? = nil,
    resetContentOffset: Bool = false
  ) {
    guard scrollView.bounds.width > 0, scrollView.bounds.height > 0 else { return }
    let size = displayedSize ?? imageView.frame.size
    let computedInsets = AlyteImageWorkspaceInsets(
      top: max(0, (scrollView.bounds.height - size.height) / 2),
      left: max(0, (scrollView.bounds.width - size.width) / 2),
      bottom: max(0, (scrollView.bounds.height - size.height) / 2),
      right: max(0, (scrollView.bounds.width - size.width) / 2))
    let resolvedInsets = insets ?? computedInsets
    scrollView.contentInset = UIEdgeInsets(
      top: resolvedInsets.top,
      left: resolvedInsets.left,
      bottom: resolvedInsets.bottom,
      right: resolvedInsets.right)

    let minOffset = CGPoint(x: -resolvedInsets.left, y: -resolvedInsets.top)
    let maxOffset = CGPoint(
      x: max(
        minOffset.x,
        scrollView.contentSize.width - scrollView.bounds.width + resolvedInsets.right),
      y: max(
        minOffset.y,
        scrollView.contentSize.height - scrollView.bounds.height + resolvedInsets.bottom))
    let current = resetContentOffset ? minOffset : scrollView.contentOffset
    let clamped = CGPoint(
      x: min(max(current.x, minOffset.x), maxOffset.x),
      y: min(max(current.y, minOffset.y), maxOffset.y))
    if scrollView.contentOffset != clamped {
      scrollView.setContentOffset(clamped, animated: false)
    }
  }

  func layoutSnapshotForTesting() -> AlyteImageWorkspaceLayoutSnapshot {
    AlyteImageWorkspaceLayoutSnapshot(
      zoomScale: scrollView.zoomScale,
      displayedSize: imageView.frame.size,
      contentInset: AlyteImageWorkspaceInsets(
        top: scrollView.contentInset.top,
        left: scrollView.contentInset.left,
        bottom: scrollView.contentInset.bottom,
        right: scrollView.contentInset.right),
      contentOffset: scrollView.contentOffset)
  }

  func configureImageForTesting(_ image: UIImage) {
    configureImage(image)
  }

  func selectRedactionForTesting(_ id: String?) {
    setSelection(id)
    layoutRegions()
  }

  func gestureTargetForTesting(at point: CGPoint) -> AlyteImageWorkspaceGesture? {
    gestureTarget(at: point).map { AlyteImageWorkspaceGesture(id: $0.id, kind: $0.role.gestureKind) }
  }

  func overlayElementFrameForTesting(
    id: String,
    kind: AlyteImageWorkspaceGestureKind
  ) -> CGRect? {
    let role: ImageWorkspaceOverlayRole = kind == .resize ? .resizeHandle : .redaction
    return overlay.subviews.first {
      ($0 as? ImageRedactionOverlayElement)?.role == role &&
        $0.accessibilityIdentifier == id
    }?.frame
  }

  func manipulatedRectForTesting(
    id: String,
    translation: CGPoint,
    kind: AlyteImageWorkspaceGestureKind
  ) -> CGRect? {
    manipulatedRect(id: id, translation: translation, role: kind == .resize ? .resizeHandle : .redaction)
  }

  private func focusStoredRegion() {
    guard let focusRegion, imageView.bounds.width > 0, imageView.bounds.height > 0,
      scrollView.bounds.width > 0, scrollView.bounds.height > 0
    else { return }
    let expanded = AlyteImageWorkspaceGeometry.focusRect(normalized: focusRegion)
    let target = pageRect(expanded)
    let targetScale = min(
      scrollView.maximumZoomScale,
      max(
        scrollView.minimumZoomScale,
        min(
          scrollView.bounds.width / max(1, target.width),
          scrollView.bounds.height / max(1, target.height)) * 0.82))
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.scrollView.setZoomScale(targetScale, animated: false)
      self.centerImage()
      let scaledCenter = CGPoint(
        x: target.midX * self.scrollView.zoomScale,
        y: target.midY * self.scrollView.zoomScale)
      let visibleSize = CGSize(
        width: self.scrollView.bounds.width,
        height: self.scrollView.bounds.height)
      let desired = CGPoint(
        x: scaledCenter.x - visibleSize.width / 2,
        y: scaledCenter.y - visibleSize.height / 2)
      let minOffset = CGPoint(
        x: -self.scrollView.contentInset.left,
        y: -self.scrollView.contentInset.top)
      let maxOffset = CGPoint(
        x: max(
          minOffset.x,
          self.scrollView.contentSize.width - visibleSize.width + self.scrollView.contentInset.right),
        y: max(
          minOffset.y,
          self.scrollView.contentSize.height - visibleSize.height + self.scrollView.contentInset.bottom))
      self.scrollView.setContentOffset(
        CGPoint(
          x: min(max(desired.x, minOffset.x), maxOffset.x),
          y: min(max(desired.y, minOffset.y), maxOffset.y)),
        animated: false)
    }
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    overlay.frame = imageView.bounds
    layoutRegions()
    centerImage()
  }

  private func pageRect(_ normalized: CGRect) -> CGRect {
    AlyteImageWorkspaceGeometry.viewRect(normalized: normalized, pageFrame: imageView.bounds)
  }

  private func normalizedRect(_ viewRect: CGRect) -> CGRect {
    let result = AlyteImageWorkspaceGeometry.normalizedRect(
      viewRect: viewRect, pageFrame: imageView.bounds)
    return CGRect(
      x: max(0, min(1, result.minX)),
      y: max(0, min(1, result.minY)),
      width: max(0.01, min(1 - result.minX, result.width)),
      height: max(0.01, min(1 - result.minY, result.height)))
  }

  private func layoutRegions() {
    if let activeGestureID {
      layoutActiveRegion(id: activeGestureID)
      return
    }
    overlay.subviews.forEach { $0.removeFromSuperview() }
    for region in regions {
      let frame = pageRect(region.rect)
      let view = ImageRedactionOverlayElement(role: .redaction, frame: frame)
      view.backgroundColor = inspectionMode
        ? UIColor.systemTeal.withAlphaComponent(0.14)
        : UIColor.black.withAlphaComponent(selectedID == region.id ? 0.72 : 0.55)
      view.layer.borderColor = (inspectionMode ? UIColor.systemTeal : UIColor.systemYellow).cgColor
      view.layer.borderWidth = inspectionMode || selectedID == region.id ? 3 : 0
      view.accessibilityLabel = labels["redaction"] ?? "Redaction"
      view.isAccessibilityElement = true
      view.accessibilityTraits = inspectionMode ? .image : .adjustable
      if !inspectionMode, selectedID == region.id { view.accessibilityTraits.insert(.selected) }
      view.accessibilityValue = accessibilityValue(for: region.rect, selected: selectedID == region.id)
      view.accessibilityIdentifier = region.id
      if !inspectionMode {
        view.accessibilityCustomActions = accessibilityActions(for: region.id)
      }
      overlay.addSubview(view)
      if !inspectionMode, selectedID == region.id {
        let handle = ImageRedactionOverlayElement(
          role: .resizeHandle,
          frame: resizeHandleFrame(for: frame))
        handle.backgroundColor = .clear
        let knobSize = InteractionMetrics.resizeKnobSize / max(0.01, scrollView.zoomScale)
        let knob = UIView(frame: CGRect(
          x: (handle.bounds.width - knobSize) / 2,
          y: (handle.bounds.height - knobSize) / 2,
          width: knobSize,
          height: knobSize))
        knob.backgroundColor = .systemYellow
        knob.layer.cornerRadius = knobSize / 2
        handle.addSubview(knob)
        handle.accessibilityLabel = labels["resize"] ?? "Resize redaction"
        handle.isAccessibilityElement = true
        handle.accessibilityTraits = .adjustable
        handle.accessibilityValue = accessibilityValue(for: region.rect, selected: true)
        handle.accessibilityIdentifier = region.id
        handle.accessibilityCustomActions = accessibilityActions(for: region.id)
        overlay.addSubview(handle)
      }
    }
  }

  private func layoutActiveRegion(id: String) {
    guard let region = regions.first(where: { $0.id == id }) else { return }
    let frame = pageRect(region.rect)
    let regionView = overlay.subviews.first {
      ($0 as? ImageRedactionOverlayElement)?.role == .redaction &&
        $0.accessibilityIdentifier == id
    }
    regionView?.frame = frame
    let handle = overlay.subviews.first {
      ($0 as? ImageRedactionOverlayElement)?.role == .resizeHandle &&
        $0.accessibilityIdentifier == id
    }
    handle?.frame = resizeHandleFrame(for: frame)
    if let handle = handle, let knob = handle.subviews.first {
      let knobSize = InteractionMetrics.resizeKnobSize / max(0.01, scrollView.zoomScale)
      knob.frame = CGRect(
        x: (handle.bounds.width - knobSize) / 2,
        y: (handle.bounds.height - knobSize) / 2,
        width: knobSize,
        height: knobSize)
      knob.layer.cornerRadius = knobSize / 2
    }
  }

  private func resizeHandleFrame(for regionFrame: CGRect) -> CGRect {
    let size = InteractionMetrics.minimumHitTarget / max(0.01, scrollView.zoomScale)
    let unclamped = CGRect(
      x: regionFrame.maxX - size / 2,
      y: regionFrame.maxY - size / 2,
      width: size,
      height: size)
    let bounds = overlay.bounds
    return CGRect(
      x: min(max(unclamped.minX, bounds.minX), max(bounds.minX, bounds.maxX - size)),
      y: min(max(unclamped.minY, bounds.minY), max(bounds.minY, bounds.maxY - size)),
      width: size,
      height: size)
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard redactMode, !inspectionMode else { return }
    let point = gesture.location(in: overlay)
    if let hit = overlay.subviews.reversed().first(where: {
      $0.frame.contains(point) && $0.accessibilityIdentifier != nil
    }) {
      setSelection(hit.accessibilityIdentifier)
    } else {
      let width = min(0.3, 120 / max(1, imageView.bounds.width))
      let height = min(0.08, 40 / max(1, imageView.bounds.height))
      let rect = normalizedRect(CGRect(
        x: point.x - width * imageView.bounds.width / 2,
        y: point.y - height * imageView.bounds.height / 2,
        width: width * imageView.bounds.width,
        height: height * imageView.bounds.height))
      history.append(regions)
      future.removeAll()
      let id = "user-redaction-\(UUID().uuidString)"
      regions.append(ImageWorkspaceRedaction(id: id, rect: rect))
      setSelection(id)
      emit()
    }
    layoutRegions()
  }

  @objc private func overlayPanned(_ gesture: UIPanGestureRecognizer) {
    manipulate(gesture, role: overlayGestureRole ?? .redaction)
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === overlayPan else { return true }
    guard redactMode, !inspectionMode else { return false }
    let point = gestureRecognizer.location(in: overlay)
    guard let target = gestureTarget(at: point) else {
      overlayGestureRole = nil
      gestureRecognizer.name = nil
      return false
    }
    overlayGestureRole = target.role
    gestureRecognizer.name = target.id
    return true
  }

  private struct ImageWorkspaceGestureTarget {
    let id: String
    let role: ImageWorkspaceOverlayRole
  }

  private func gestureTarget(at point: CGPoint) -> ImageWorkspaceGestureTarget? {
    let elements = overlay.subviews.compactMap { $0 as? ImageRedactionOverlayElement }
    let handles = elements.filter { $0.role == .resizeHandle }
    let regions = elements.filter { $0.role == .redaction }

    for handle in handles where handle.frame.contains(point) {
      let knobSize = InteractionMetrics.resizeKnobSize / max(0.01, scrollView.zoomScale)
      let knobFrame = handle.frame.insetBy(
        dx: (handle.bounds.width - knobSize) / 2,
        dy: (handle.bounds.height - knobSize) / 2)
      let region = regions.first { $0.accessibilityIdentifier == handle.accessibilityIdentifier }
      if knobFrame.contains(point) || !(region?.frame.contains(point) ?? false) {
        return ImageWorkspaceGestureTarget(
          id: handle.accessibilityIdentifier ?? "",
          role: .resizeHandle)
      }
    }

    let targetInset = InteractionMetrics.minimumHitTarget / max(0.01, scrollView.zoomScale)
    for region in regions.reversed() {
      let frame = region.frame
      let horizontalSlop = max(8 / max(0.01, scrollView.zoomScale), (targetInset - frame.width) / 2)
      let verticalSlop = max(8 / max(0.01, scrollView.zoomScale), (targetInset - frame.height) / 2)
      if frame.insetBy(dx: -horizontalSlop, dy: -verticalSlop).contains(point) {
        return ImageWorkspaceGestureTarget(
          id: region.accessibilityIdentifier ?? "",
          role: .redaction)
      }
    }
    return nil
  }

  private func manipulatedRect(
    id: String,
    translation: CGPoint,
    role: ImageWorkspaceOverlayRole
  ) -> CGRect? {
    guard let original = regions.first(where: { $0.id == id }) else { return nil }
    return AlyteImageWorkspaceGeometry.manipulated(
      original: original.rect,
      translation: translation,
      pageFrame: imageView.bounds,
      resize: role == .resizeHandle,
      minimumViewSize: 24 / max(0.01, scrollView.zoomScale))
  }

  private func manipulate(_ gesture: UIPanGestureRecognizer, role: ImageWorkspaceOverlayRole) {
    guard redactMode, !inspectionMode,
      let id = gesture.name,
      let index = regions.firstIndex(where: { $0.id == id })
    else { return }
    if gesture.state == .began {
      guard interactionState.beginGesture(id: id, kind: role.gestureKind) else { return }
      setSelection(id)
      startRegions = regions
      deferredRegions = nil
      layoutActiveRegion(id: id)
    }
    guard activeGestureID == id,
      let original = startRegions.first(where: { $0.id == id })
    else { return }
    let translation = gesture.translation(in: overlay)
    regions[index].rect = manipulatedRect(id: id, translation: translation, role: role) ?? original.rect
    layoutActiveRegion(id: id)
    if gesture.state == .ended {
      if regions != startRegions {
        history.append(startRegions)
        future.removeAll()
      }
      finishGesture(applyDeferredRegions: false)
      emit()
    } else if gesture.state == .cancelled || gesture.state == .failed {
      regions = startRegions
      finishGesture(applyDeferredRegions: true)
    }
  }

  private func finishGesture(applyDeferredRegions: Bool) {
    interactionState.endGesture()
    overlayGestureRole = nil
    if applyDeferredRegions, let deferredRegions { regions = deferredRegions }
    deferredRegions = nil
    reconcileSelection()
    layoutRegions()
  }

  private func setSelection(_ id: String?) {
    let next = id.flatMap { candidate in regions.contains(where: { $0.id == candidate }) ? candidate : nil }
    let previous = selectedID
    interactionState.select(next)
    guard selectedID != previous else { return }
    onSelectionChange(["selected": selectedID != nil])
  }

  private func reconcileSelection() { setSelection(selectedID) }

  private func accessibilityActions(for id: String) -> [UIAccessibilityCustomAction] {
    func action(_ key: String, _ fallback: String, _ change: @escaping () -> Void)
      -> UIAccessibilityCustomAction
    {
      UIAccessibilityCustomAction(name: labels[key] ?? fallback) { _ in
        change()
        return true
      }
    }
    return [
      action("moveLeft", "Move left") { self.adjust(id: id, dx: -0.01, dy: 0, size: 0) },
      action("moveRight", "Move right") { self.adjust(id: id, dx: 0.01, dy: 0, size: 0) },
      action("moveUp", "Move up") { self.adjust(id: id, dx: 0, dy: -0.01, size: 0) },
      action("moveDown", "Move down") { self.adjust(id: id, dx: 0, dy: 0.01, size: 0) },
      action("grow", "Grow") { self.adjust(id: id, dx: 0, dy: 0, size: 0.01) },
      action("shrink", "Shrink") { self.adjust(id: id, dx: 0, dy: 0, size: -0.01) },
      action("remove", "Remove") { self.setSelection(id); self.removeSelected() },
    ]
  }

  private func accessibilityValue(for rect: CGRect, selected: Bool) -> String {
    let prefix = labels["value"] ?? "Size"
    let state = selected ? (labels["selected"] ?? "Selected") : (labels["notSelected"] ?? "Not selected")
    return "\(prefix): \(Int(rect.width * 100))% × \(Int(rect.height * 100))%; \(state)"
  }

  private func adjust(id: String, dx: CGFloat, dy: CGFloat, size: CGFloat) {
    guard !inspectionMode else { return }
    guard let index = regions.firstIndex(where: { $0.id == id }) else { return }
    history.append(regions)
    future.removeAll()
    setSelection(id)
    var rect = regions[index].rect
    rect.origin.x = max(0, min(1 - rect.width, rect.origin.x + dx))
    rect.origin.y = max(0, min(1 - rect.height, rect.origin.y + dy))
    rect.size.width = max(0.01, min(1 - rect.minX, rect.width + size))
    rect.size.height = max(0.01, min(1 - rect.minY, rect.height + size))
    regions[index].rect = rect
    emit()
    layoutRegions()
  }

  @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
    let minimum = scrollView.minimumZoomScale
    let zoom = scrollView.zoomScale > minimum * 1.2
      ? minimum
      : min(scrollView.maximumZoomScale, minimum * 2.5)
    scrollView.setZoomScale(zoom, animated: !UIAccessibility.isReduceMotionEnabled)
  }

  private func emit() {
    onRedactionsChange([
      "pageIndex": 0,
      "redactions": regions.map { [
        "id": $0.id,
        "rect": ["x": $0.rect.minX, "y": $0.rect.minY, "width": $0.rect.width, "height": $0.rect.height],
      ] },
      "canUndo": !history.isEmpty,
      "canRedo": !future.isEmpty,
    ])
  }
}
