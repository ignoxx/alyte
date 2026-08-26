import ExpoModulesCore
import PDFKit
import UIKit

private struct WorkspaceRedaction: Equatable {
  let id: String
  var rect: CGRect
}

private enum RedactionOverlayRole: Equatable {
  case redaction
  case resizeHandle

  var gestureKind: AlytePDFWorkspaceGestureKind {
    switch self {
    case .redaction: return .move
    case .resizeHandle: return .resize
    }
  }
}

private final class RedactionOverlayElement: UIView {
  let role: RedactionOverlayRole

  init(role: RedactionOverlayRole, frame: CGRect) {
    self.role = role
    super.init(frame: frame)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}

private final class RedactionOverlayView: UIView {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    let frames = subviews.compactMap { view -> AlytePDFWorkspaceOverlayFrame? in
      guard let element = view as? RedactionOverlayElement,
        !view.isHidden,
        view.alpha > 0,
        let id = view.accessibilityIdentifier
      else { return nil }
      return AlytePDFWorkspaceOverlayFrame(
        id: id, frame: view.frame, kind: element.role.gestureKind)
    }
    return AlytePDFWorkspaceGeometry.gestureTarget(at: point, overlayFrames: frames) != nil
  }
}

/// PDFKit remains the sole authority for page geometry, zoom and gesture conversion. React only
/// receives normalized, top-left source-page coordinates after a manipulation commits.
final class AlytePDFWorkspaceView: ExpoView, UIGestureRecognizerDelegate {
  let onRedactionsChange = EventDispatcher()
  let onPageChange = EventDispatcher()
  let onReady = EventDispatcher()
  let onFailure = EventDispatcher()
  let onSelectionChange = EventDispatcher()

  private let pdfView = PDFView()
  private let overlay = RedactionOverlayView()
  private let overlayPan = UIPanGestureRecognizer()
  private var document: PDFDocument?
  private var regions: [WorkspaceRedaction] = []
  private var selectedID: String?
  private var history: [[WorkspaceRedaction]] = []
  private var future: [[WorkspaceRedaction]] = []
  private var startRegions: [WorkspaceRedaction] = []
  private var labels: [String: String] = [:]
  private var activeGestureID: String?
  private var pendingOverlayGestureTarget: PDFWorkspaceGestureTarget?
  private var overlayGestureRole: RedactionOverlayRole?
  private var deferredRegions: [WorkspaceRedaction]?
  private var deferredLabels: [String: String]?
  private var focusRegion: CGRect?
  private var lastEmittedRegions: [WorkspaceRedaction] = []
  var inspectionMode = false {
    didSet {
      guard oldValue != inspectionMode else { return }
      overlay.isUserInteractionEnabled = redactMode && !inspectionMode
      if inspectionMode { clearSelection() }
      layoutRegions()
    }
  }

  var sourcePath: String = "" { didSet { if oldValue != sourcePath { load() } } }
  var pageIndex: Int = 0 {
    didSet {
      if oldValue != pageIndex {
        setSelection(nil)
        showPage()
      }
    }
  }
  var redactMode = false {
    didSet {
      overlay.isUserInteractionEnabled = redactMode && !inspectionMode
      if !redactMode { clearSelection() }
    }
  }
  var rotation: Int = 0 { didSet { if oldValue != rotation { showPage() } } }
  private var crop: CGRect?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .secondarySystemBackground
    pdfView.autoScales = true
    pdfView.displayMode = .singlePage
    pdfView.displayDirection = .horizontal
    pdfView.displaysPageBreaks = false
    pdfView.backgroundColor = .secondarySystemBackground
    addSubview(pdfView)
    overlay.backgroundColor = .clear
    addSubview(overlay)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
    doubleTap.numberOfTapsRequired = 2
    doubleTap.delegate = self
    addGestureRecognizer(doubleTap)
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    tap.require(toFail: doubleTap)
    pdfView.addGestureRecognizer(tap)
    let overlayTap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    overlayTap.cancelsTouchesInView = false
    overlayTap.require(toFail: doubleTap)
    overlay.addGestureRecognizer(overlayTap)
    overlayPan.addTarget(self, action: #selector(overlayPanned(_:)))
    overlayPan.delegate = self
    overlayPan.cancelsTouchesInView = false
    overlay.addGestureRecognizer(overlayPan)
    reapplyPDFGestureDependencies()
    NotificationCenter.default.addObserver(
      self, selector: #selector(pdfGeometryChanged), name: .PDFViewScaleChanged, object: pdfView)
    NotificationCenter.default.addObserver(
      self, selector: #selector(pdfGeometryChanged), name: .PDFViewPageChanged, object: pdfView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    pdfView.frame = bounds
    overlay.frame = bounds
    reapplyPDFGestureDependencies()
    layoutRegions()
  }

  func setRedactions(_ values: [[String: Any]]) {
    let next = values.compactMap { value -> WorkspaceRedaction? in
      guard let id = value["id"] as? String, let rect = value["rect"] as? [String: Any],
        let x = (rect["x"] as? NSNumber)?.doubleValue,
        let y = (rect["y"] as? NSNumber)?.doubleValue,
        let width = (rect["width"] as? NSNumber)?.doubleValue,
        let height = (rect["height"] as? NSNumber)?.doubleValue
      else { return nil }
      return WorkspaceRedaction(id: id, rect: CGRect(x: x, y: y, width: width, height: height))
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

  func setCrop(_ value: [String: Any]?) {
    guard let value else {
      if crop != nil {
        crop = nil
        showPage()
      }
      return
    }
    guard let x = (value["x"] as? NSNumber)?.doubleValue,
      let y = (value["y"] as? NSNumber)?.doubleValue,
      let width = (value["width"] as? NSNumber)?.doubleValue,
      let height = (value["height"] as? NSNumber)?.doubleValue
    else { return }
    let next = CGRect(x: x, y: y, width: width, height: height)
    if next != crop {
      crop = next
      showPage()
    }
  }

  func setAccessibilityLabels(_ value: [String: String]) {
    guard value != labels else { return }
    if activeGestureID != nil {
      deferredLabels = value
      return
    }
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
    guard let previous = history.popLast() else { return }
    future.append(regions)
    regions = previous
    reconcileSelection()
    emit()
    layoutRegions()
  }
  func redoEdit() {
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
    guard let selectedID, regions.contains(where: { $0.id == selectedID }) else { return }
    history.append(regions)
    future.removeAll()
    regions.removeAll { $0.id == selectedID }
    setSelection(nil)
    emit()
    layoutRegions()
  }

  private func load() {
    guard !sourcePath.isEmpty, let loaded = PDFDocument(url: URL(fileURLWithPath: sourcePath)),
      !loaded.isLocked
    else {
      onFailure(["message": "The PDF could not be opened in the privacy workspace"])
      return
    }
    document = loaded
    pdfView.document = loaded
    showPage()
    onReady(["pageCount": loaded.pageCount])
  }

  private func showPage() {
    guard let document, pageIndex >= 0, pageIndex < document.pageCount,
      let page = document.page(at: pageIndex)
    else { return }
    let media = page.bounds(for: .mediaBox)
    page.rotation = rotation
    if let crop {
      page.setBounds(
        CGRect(
          x: media.minX + crop.minX * media.width,
          y: media.maxY - crop.maxY * media.height,
          width: crop.width * media.width,
          height: crop.height * media.height), for: .cropBox)
    } else {
      page.setBounds(media, for: .cropBox)
    }
    pdfView.go(to: page)
    pdfView.autoScales = true
    reapplyPDFGestureDependencies()
    layoutRegions()
    focusStoredRegion()
    onPageChange(["pageIndex": pageIndex])
  }

  /// PDFView's scroll view is private and may be recreated when a document or page is loaded.
  /// Requiring its pan to fail the stable edit recognizer gives body/handle edits priority only
  /// for touches that reached the redaction overlay. Blank page touches never hit that overlay,
  /// so PDFKit's pan and pinch recognizers remain available there.
  private func reapplyPDFGestureDependencies() {
    for scrollView in descendantScrollViews(of: pdfView) {
      scrollView.panGestureRecognizer.require(toFail: overlayPan)
    }
  }

  private func descendantScrollViews(of view: UIView) -> [UIScrollView] {
    view.subviews.flatMap { child in
      let nested = descendantScrollViews(of: child)
      if let scrollView = child as? UIScrollView {
        return [scrollView] + nested
      }
      return nested
    }
  }

  private func pageRect(_ normalized: CGRect) -> CGRect? {
    guard let page = document?.page(at: pageIndex) else { return nil }
    let box = page.bounds(for: .mediaBox)
    let pdfRect = CGRect(
      x: box.minX + normalized.minX * box.width,
      y: box.maxY - normalized.maxY * box.height,
      width: normalized.width * box.width,
      height: normalized.height * box.height)
    return pdfView.convert(pdfRect, from: page)
  }

  private func normalizedRect(_ viewRect: CGRect) -> CGRect? {
    guard let page = document?.page(at: pageIndex) else { return nil }
    let box = page.bounds(for: .mediaBox)
    let pdfRect = pdfView.convert(viewRect, to: page)
    let x = (pdfRect.minX - box.minX) / box.width
    let y = (box.maxY - pdfRect.maxY) / box.height
    return CGRect(
      x: max(0, min(1, x)), y: max(0, min(1, y)),
      width: max(0.01, min(1 - x, pdfRect.width / box.width)),
      height: max(0.01, min(1 - y, pdfRect.height / box.height)))
  }

  private func layoutRegions() {
    if let activeGestureID {
      layoutActiveRegion(id: activeGestureID)
      return
    }
    overlay.subviews.forEach { $0.removeFromSuperview() }
    for region in regions {
      guard let frame = pageRect(region.rect) else { continue }
      let view = RedactionOverlayElement(role: .redaction, frame: frame)
      view.backgroundColor =
        inspectionMode
        ? UIColor.systemTeal.withAlphaComponent(0.14)
        : UIColor.black.withAlphaComponent(selectedID == region.id ? 0.72 : 0.55)
      view.layer.borderColor = (inspectionMode ? UIColor.systemTeal : UIColor.systemYellow).cgColor
      view.layer.borderWidth = inspectionMode || selectedID == region.id ? 3 : 0
      view.accessibilityLabel = labels["redaction"] ?? "Redaction"
      view.isAccessibilityElement = true
      view.accessibilityTraits = inspectionMode ? .image : .adjustable
      view.accessibilityValue = accessibilityValue(for: region.rect, selected: selectedID == region.id)
      if !inspectionMode {
        if selectedID == region.id { view.accessibilityTraits.insert(.selected) }
        view.accessibilityCustomActions = accessibilityActions(for: region.id)
      }
      view.accessibilityIdentifier = region.id
      // The ancestor overlay is the sole direct-touch owner. Keeping these views interaction-free
      // avoids replacing the stable pan recognizer during a React/PDFKit layout pass while their
      // accessibility elements and custom actions remain intact.
      view.isUserInteractionEnabled = false
      overlay.addSubview(view)
      if !inspectionMode, selectedID == region.id {
        let handle = RedactionOverlayElement(
          role: .resizeHandle, frame: resizeHandleFrame(for: frame))
        handle.backgroundColor = .clear
        let knob = UIView(frame: CGRect(x: 14, y: 14, width: 16, height: 16))
        knob.backgroundColor = .systemYellow
        knob.layer.cornerRadius = 8
        handle.addSubview(knob)
        handle.accessibilityLabel = labels["resize"] ?? "Resize redaction"
        handle.isAccessibilityElement = true
        handle.accessibilityTraits = .adjustable
        handle.accessibilityValue = accessibilityValue(for: region.rect, selected: true)
        handle.accessibilityIdentifier = region.id
        handle.accessibilityCustomActions = accessibilityActions(for: region.id)
        handle.isUserInteractionEnabled = false
        overlay.addSubview(handle)
      }
    }
  }

  private func resizeHandleFrame(for regionFrame: CGRect) -> CGRect {
    let size = AlytePDFWorkspaceGeometry.minimumHitTarget
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

  func gestureTargetForTesting(at point: CGPoint) -> AlytePDFWorkspaceGesture? {
    gestureTarget(at: point).map {
      AlytePDFWorkspaceGesture(id: $0.id, kind: $0.role.gestureKind)
    }
  }

  func overlayElementFrameForTesting(
    id: String,
    kind: AlytePDFWorkspaceGestureKind
  ) -> CGRect? {
    let role: RedactionOverlayRole = kind == .resize ? .resizeHandle : .redaction
    return overlay.subviews.first {
      ($0 as? RedactionOverlayElement)?.role == role
        && $0.accessibilityIdentifier == id
    }?.frame
  }

  func beginOverlayGestureForTesting(at point: CGPoint) -> AlytePDFWorkspaceGesture? {
    guard let target = gestureTarget(at: point) else { return nil }
    pendingOverlayGestureTarget = target
    guard gestureRecognizerShouldBegin(overlayPan) else { return nil }
    return AlytePDFWorkspaceGesture(id: target.id, kind: target.role.gestureKind)
  }

  func overlayPannedForTesting(_ gesture: UIPanGestureRecognizer) {
    overlayPanned(gesture)
  }

  func redactionsForTesting() -> [(id: String, rect: CGRect)] {
    regions.map { (id: $0.id, rect: $0.rect) }
  }

  func lastEmittedRedactionsForTesting() -> [(id: String, rect: CGRect)] {
    lastEmittedRegions.map { (id: $0.id, rect: $0.rect) }
  }

  func canUndoForTesting() -> Bool { !history.isEmpty }

  private func focusStoredRegion() {
    guard let focusRegion,
      let page = document?.page(at: pageIndex)
    else { return }
    let box = page.bounds(for: .mediaBox)
    let expanded = AlytePDFWorkspaceGeometry.focusRect(normalized: focusRegion)
    let target = CGRect(
      x: box.minX + expanded.minX * box.width,
      y: box.maxY - expanded.maxY * box.height,
      width: expanded.width * box.width,
      height: expanded.height * box.height)
    DispatchQueue.main.async { [weak self] in self?.pdfView.go(to: target, on: page) }
  }

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
      action("remove", "Remove") {
        self.selectedID = id
        self.removeSelected()
      },
    ]
  }

  private func accessibilityValue(for rect: CGRect, selected: Bool) -> String {
    let prefix = labels["value"] ?? "Size"
    let state = selected
      ? (labels["selected"] ?? "Selected")
      : (labels["notSelected"] ?? "Not selected")
    return "\(prefix): \(Int(rect.width * 100))% × \(Int(rect.height * 100))%; \(state)"
  }

  private func adjust(id: String, dx: CGFloat, dy: CGFloat, size: CGFloat) {
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

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard redactMode else { return }
    let point = gesture.location(in: overlay)
    if let target = gestureTarget(at: point) {
      // Use the same expanded hit target as the stable pan recognizer so a tap just outside a
      // small redaction selects it instead of accidentally creating a second redaction.
      setSelection(target.id)
    } else if redactMode,
      let rect = normalizedRect(CGRect(x: point.x - 55, y: point.y - 18, width: 110, height: 36))
    {
      history.append(regions)
      future.removeAll()
      let id = "user-redaction-\(UUID().uuidString)"
      regions.append(WorkspaceRedaction(id: id, rect: rect))
      setSelection(id)
      emit()
    } else {
      setSelection(nil)
    }
    layoutRegions()
  }

  @objc private func overlayPanned(_ gesture: UIPanGestureRecognizer) {
    manipulate(gesture)
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldReceive touch: UITouch
  ) -> Bool {
    guard gestureRecognizer === overlayPan else { return true }
    pendingOverlayGestureTarget = gestureTarget(at: touch.location(in: overlay))
    return true
  }

  override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === overlayPan else { return true }
    guard redactMode, !inspectionMode else {
      pendingOverlayGestureTarget = nil
      overlayGestureRole = nil
      return false
    }
    let target = pendingOverlayGestureTarget ??
      gestureTarget(at: gestureRecognizer.location(in: overlay))
    pendingOverlayGestureTarget = nil
    guard let target else {
      // This is the critical blank-space escape hatch. The edit recognizer fails immediately,
      // leaving PDFKit's native pan/pinch recognizers untouched.
      overlayGestureRole = nil
      gestureRecognizer.name = nil
      return false
    }
    overlayGestureRole = target.role
    gestureRecognizer.name = target.id
    return true
  }

  private struct PDFWorkspaceGestureTarget {
    let id: String
    let role: RedactionOverlayRole
  }

  private func gestureTarget(at point: CGPoint) -> PDFWorkspaceGestureTarget? {
    let frames = overlay.subviews.compactMap { view -> AlytePDFWorkspaceOverlayFrame? in
      guard let element = view as? RedactionOverlayElement,
        let id = view.accessibilityIdentifier
      else { return nil }
      return AlytePDFWorkspaceOverlayFrame(
        id: id, frame: view.frame, kind: element.role.gestureKind)
    }
    guard let target = AlytePDFWorkspaceGeometry.gestureTarget(
      at: point, overlayFrames: frames)
    else { return nil }
    return PDFWorkspaceGestureTarget(
      id: target.id,
      role: target.kind == .resize ? .resizeHandle : .redaction)
  }

  private func manipulate(_ gesture: UIPanGestureRecognizer) {
    guard let id = gesture.name else { return }
    guard let role = overlayGestureRole,
      let index = regions.firstIndex(where: { $0.id == id })
    else {
      if gesture.state == .failed {
        overlayGestureRole = nil
        gesture.name = nil
      }
      return
    }
    if gesture.state == .began {
      activeGestureID = id
      setSelection(id)
      startRegions = regions
      deferredRegions = nil
      layoutActiveRegion(id: id)
    }
    guard activeGestureID == id,
      let original = startRegions.first(where: { $0.id == id }),
      let pageFrame = pageRect(CGRect(x: 0, y: 0, width: 1, height: 1))
    else { return }
    let translation = gesture.translation(in: overlay)
    regions[index].rect = AlytePDFWorkspaceGeometry.manipulated(
      original: original.rect,
      translation: translation,
      pageFrame: pageFrame,
      rotation: rotation,
      resize: role == .resizeHandle
    )
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

  /// Keeps the recognizer's view in the hierarchy for the entire UIKit gesture lifecycle.
  private func layoutActiveRegion(id: String) {
    guard let region = regions.first(where: { $0.id == id }),
      let frame = pageRect(region.rect)
    else { return }
    let regionView = overlay.subviews.first {
      ($0 as? RedactionOverlayElement)?.role == .redaction
        && $0.accessibilityIdentifier == id
    }
    regionView?.frame = frame
    regionView?.backgroundColor = UIColor.black.withAlphaComponent(0.72)
    regionView?.layer.borderWidth = 2
    regionView?.accessibilityValue = accessibilityValue(for: region.rect, selected: true)
    let handle = overlay.subviews.first {
      ($0 as? RedactionOverlayElement)?.role == .resizeHandle
        && $0.accessibilityIdentifier == id
    }
    handle?.frame = resizeHandleFrame(for: frame)
    handle?.accessibilityValue = accessibilityValue(for: region.rect, selected: true)
  }

  private func finishGesture(applyDeferredRegions: Bool) {
    activeGestureID = nil
    overlayGestureRole = nil
    overlayPan.name = nil
    pendingOverlayGestureTarget = nil
    if applyDeferredRegions, let deferredRegions { regions = deferredRegions }
    deferredRegions = nil
    if let deferredLabels { labels = deferredLabels }
    deferredLabels = nil
    reconcileSelection()
    layoutRegions()
  }

  private func setSelection(_ id: String?) {
    let update = AlytePDFWorkspaceGeometry.selectionBridgeUpdate(
      current: selectedID, requested: id, regionIDs: regions.map(\.id))
    selectedID = update.selectedID
    guard update.shouldEmit else { return }
    onSelectionChange(["selected": update.isSelected])
  }

  private func reconcileSelection() {
    setSelection(
      AlytePDFWorkspaceGeometry.reconciledSelection(selectedID, regionIDs: regions.map(\.id)))
  }

  @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
    let minimum = pdfView.minScaleFactor
    if pdfView.scaleFactor > minimum * 1.2 {
      pdfView.scaleFactor = minimum
    } else {
      pdfView.scaleFactor = min(pdfView.maxScaleFactor, minimum * 2.5)
    }
  }

  @objc private func pdfGeometryChanged() {
    // PDFKit can rebuild its internal scroll hierarchy after a document/page/scale change. Keep
    // this dependency narrow and reapply it to the current hierarchy; blank-space touches still
    // skip the overlay recognizer and remain fully native.
    reapplyPDFGestureDependencies()
    layoutRegions()
  }

  private func emit() {
    lastEmittedRegions = regions
    onRedactionsChange([
      "pageIndex": pageIndex,
      "redactions": regions.map {
        [
          "id": $0.id,
          "rect": [
            "x": $0.rect.minX, "y": $0.rect.minY, "width": $0.rect.width, "height": $0.rect.height,
          ],
        ]
      }, "canUndo": !history.isEmpty, "canRedo": !future.isEmpty,
    ])
  }
}
