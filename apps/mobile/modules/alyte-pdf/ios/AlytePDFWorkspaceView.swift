import ExpoModulesCore
import PDFKit
import UIKit

private struct WorkspaceRedaction: Equatable {
  let id: String
  var rect: CGRect
}

private final class RedactionOverlayView: UIView {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    subviews.contains {
      !$0.isHidden && $0.alpha > 0 && $0.frame.insetBy(dx: -8, dy: -8).contains(point)
    }
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
  private var document: PDFDocument?
  private var regions: [WorkspaceRedaction] = []
  private var selectedID: String?
  private var history: [[WorkspaceRedaction]] = []
  private var future: [[WorkspaceRedaction]] = []
  private var startRegions: [WorkspaceRedaction] = []
  private var labels: [String: String] = [:]
  private var activeGestureID: String?
  private var deferredRegions: [WorkspaceRedaction]?
  private var deferredLabels: [String: String]?

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
      overlay.isUserInteractionEnabled = redactMode
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
    NotificationCenter.default.addObserver(
      self, selector: #selector(pdfGeometryChanged), name: .PDFViewScaleChanged, object: pdfView)
    NotificationCenter.default.addObserver(
      self, selector: #selector(pdfGeometryChanged), name: .PDFViewPageChanged, object: pdfView)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    pdfView.frame = bounds
    overlay.frame = bounds
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
    layoutRegions()
    onPageChange(["pageIndex": pageIndex])
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
      let view = UIView(frame: frame)
      view.backgroundColor = UIColor.black.withAlphaComponent(selectedID == region.id ? 0.72 : 0.55)
      view.layer.borderColor = UIColor.systemYellow.cgColor
      view.layer.borderWidth = selectedID == region.id ? 2 : 0
      view.accessibilityLabel = labels["redaction"] ?? "Redaction"
      view.isAccessibilityElement = true
      view.accessibilityTraits = .adjustable
      if selectedID == region.id { view.accessibilityTraits.insert(.selected) }
      view.accessibilityCustomActions = accessibilityActions(for: region.id)
      let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
      pan.name = region.id
      view.addGestureRecognizer(pan)
      view.accessibilityIdentifier = region.id
      overlay.addSubview(view)
      if selectedID == region.id {
        let handle = UIView(
          frame: CGRect(x: frame.maxX - 22, y: frame.maxY - 22, width: 44, height: 44))
        handle.backgroundColor = .clear
        let knob = UIView(frame: CGRect(x: 14, y: 14, width: 16, height: 16))
        knob.backgroundColor = .systemYellow
        knob.layer.cornerRadius = 8
        handle.addSubview(knob)
        handle.accessibilityIdentifier = region.id
        let resize = UIPanGestureRecognizer(target: self, action: #selector(resized(_:)))
        resize.name = region.id
        handle.addGestureRecognizer(resize)
        overlay.addSubview(handle)
      }
    }
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
    if let hit = overlay.subviews.reversed().first(where: {
      $0.frame.contains(point) && $0.accessibilityIdentifier != nil
    }) {
      setSelection(hit.accessibilityIdentifier)
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

  @objc private func panned(_ gesture: UIPanGestureRecognizer) {
    manipulate(gesture, resize: false)
  }
  @objc private func resized(_ gesture: UIPanGestureRecognizer) {
    manipulate(gesture, resize: true)
  }

  private func manipulate(_ gesture: UIPanGestureRecognizer, resize: Bool) {
    guard let id = gesture.name,
      let index = regions.firstIndex(where: { $0.id == id })
    else { return }
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
      resize: resize
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
      $0.accessibilityIdentifier == id
        && $0.gestureRecognizers?.contains(where: { $0 is UIPanGestureRecognizer }) == true
    }
    regionView?.frame = frame
    regionView?.backgroundColor = UIColor.black.withAlphaComponent(0.72)
    regionView?.layer.borderWidth = 2
    let handle = overlay.subviews.first {
      $0 !== regionView && $0.gestureRecognizers?.contains(where: { $0.name == id }) == true
    }
    handle?.frame = CGRect(x: frame.maxX - 22, y: frame.maxY - 22, width: 44, height: 44)
  }

  private func finishGesture(applyDeferredRegions: Bool) {
    activeGestureID = nil
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

  @objc private func pdfGeometryChanged() { layoutRegions() }

  private func emit() {
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
