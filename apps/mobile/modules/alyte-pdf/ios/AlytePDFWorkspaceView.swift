import ExpoModulesCore
import PDFKit
import UIKit

private struct WorkspaceRedaction: Equatable {
  let id: String
  var rect: CGRect
}

private final class RedactionOverlayView: UIView {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    subviews.contains { !$0.isHidden && $0.alpha > 0 && $0.frame.insetBy(dx: -8, dy: -8).contains(point) }
  }
}

/// PDFKit remains the sole authority for page geometry, zoom and gesture conversion. React only
/// receives normalized, top-left source-page coordinates after a manipulation commits.
final class AlytePDFWorkspaceView: ExpoView, UIGestureRecognizerDelegate {
  let onRedactionsChange = EventDispatcher()
  let onPageChange = EventDispatcher()
  let onReady = EventDispatcher()
  let onFailure = EventDispatcher()

  private let pdfView = PDFView()
  private let overlay = RedactionOverlayView()
  private var document: PDFDocument?
  private var regions: [WorkspaceRedaction] = []
  private var selectedID: String?
  private var history: [[WorkspaceRedaction]] = []
  private var future: [[WorkspaceRedaction]] = []
  private var startRegions: [WorkspaceRedaction] = []
  private var startPoint = CGPoint.zero
  private var activeHandle: UIView?

  var sourcePath: String = "" { didSet { if oldValue != sourcePath { load() } } }
  var pageIndex: Int = 0 { didSet { if oldValue != pageIndex { showPage() } } }
  var redactMode = false { didSet { overlay.isUserInteractionEnabled = redactMode; if !redactMode { clearSelection() } } }
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
    NotificationCenter.default.addObserver(self, selector: #selector(pdfGeometryChanged), name: .PDFViewScaleChanged, object: pdfView)
    NotificationCenter.default.addObserver(self, selector: #selector(pdfGeometryChanged), name: .PDFViewPageChanged, object: pdfView)
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
            let height = (rect["height"] as? NSNumber)?.doubleValue else { return nil }
      return WorkspaceRedaction(id: id, rect: CGRect(x: x, y: y, width: width, height: height))
    }
    if next != regions { regions = next; selectedID = nil; history.removeAll(); future.removeAll(); layoutRegions() }
  }

  func setCrop(_ value: [String: Any]?) {
    guard let value else { if crop != nil { crop = nil; showPage() }; return }
    guard let x = (value["x"] as? NSNumber)?.doubleValue,
          let y = (value["y"] as? NSNumber)?.doubleValue,
          let width = (value["width"] as? NSNumber)?.doubleValue,
          let height = (value["height"] as? NSNumber)?.doubleValue else { return }
    let next = CGRect(x: x, y: y, width: width, height: height)
    if next != crop { crop = next; showPage() }
  }

  func undoEdit() { guard let previous = history.popLast() else { return }; future.append(regions); regions = previous; emit(); layoutRegions() }
  func redoEdit() { guard let next = future.popLast() else { return }; history.append(regions); regions = next; emit(); layoutRegions() }
  func clearSelection() { selectedID = nil; layoutRegions() }

  private func load() {
    guard !sourcePath.isEmpty, let loaded = PDFDocument(url: URL(fileURLWithPath: sourcePath)), !loaded.isLocked else {
      onFailure(["message": "The PDF could not be opened in the privacy workspace"]); return
    }
    document = loaded
    pdfView.document = loaded
    showPage()
    onReady(["pageCount": loaded.pageCount])
  }

  private func showPage() {
    guard let document, pageIndex >= 0, pageIndex < document.pageCount,
          let page = document.page(at: pageIndex) else { return }
    let media = page.bounds(for: .mediaBox)
    page.rotation = rotation
    if let crop {
      page.setBounds(CGRect(x: media.minX + crop.minX * media.width,
                            y: media.maxY - crop.maxY * media.height,
                            width: crop.width * media.width,
                            height: crop.height * media.height), for: .cropBox)
    } else { page.setBounds(media, for: .cropBox) }
    pdfView.go(to: page)
    pdfView.autoScales = true
    layoutRegions()
    onPageChange(["pageIndex": pageIndex])
  }

  private func pageRect(_ normalized: CGRect) -> CGRect? {
    guard let page = document?.page(at: pageIndex) else { return nil }
    let box = page.bounds(for: .mediaBox)
    let pdfRect = CGRect(x: box.minX + normalized.minX * box.width,
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
    return CGRect(x: max(0, min(1, x)), y: max(0, min(1, y)),
                  width: max(0.01, min(1 - x, pdfRect.width / box.width)),
                  height: max(0.01, min(1 - y, pdfRect.height / box.height)))
  }

  private func layoutRegions() {
    overlay.subviews.forEach { $0.removeFromSuperview() }
    for region in regions {
      guard let frame = pageRect(region.rect) else { continue }
      let view = UIView(frame: frame)
      view.backgroundColor = UIColor.black.withAlphaComponent(selectedID == region.id ? 0.72 : 0.55)
      view.layer.borderColor = UIColor.systemYellow.cgColor
      view.layer.borderWidth = selectedID == region.id ? 2 : 0
      view.accessibilityLabel = "Redaction"
      view.isAccessibilityElement = true
      view.accessibilityTraits = .adjustable
      let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
      view.addGestureRecognizer(pan)
      view.accessibilityIdentifier = region.id
      overlay.addSubview(view)
      if selectedID == region.id {
        let handle = UIView(frame: CGRect(x: frame.maxX - 22, y: frame.maxY - 22, width: 44, height: 44))
        handle.backgroundColor = .clear
        let knob = UIView(frame: CGRect(x: 14, y: 14, width: 16, height: 16))
        knob.backgroundColor = .systemYellow; knob.layer.cornerRadius = 8; handle.addSubview(knob)
        handle.accessibilityIdentifier = region.id
        let resize = UIPanGestureRecognizer(target: self, action: #selector(resized(_:)))
        handle.addGestureRecognizer(resize); overlay.addSubview(handle)
      }
    }
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard redactMode else { return }
    let point = gesture.location(in: overlay)
    if let hit = overlay.subviews.reversed().first(where: { $0.frame.contains(point) && $0.accessibilityIdentifier != nil }) {
      selectedID = hit.accessibilityIdentifier
    } else if redactMode, let rect = normalizedRect(CGRect(x: point.x - 55, y: point.y - 18, width: 110, height: 36)) {
      history.append(regions); future.removeAll()
      let id = "user-redaction-\(UUID().uuidString)"
      regions.append(WorkspaceRedaction(id: id, rect: rect)); selectedID = id; emit()
    } else { selectedID = nil }
    layoutRegions()
  }

  @objc private func panned(_ gesture: UIPanGestureRecognizer) { manipulate(gesture, resize: false) }
  @objc private func resized(_ gesture: UIPanGestureRecognizer) { manipulate(gesture, resize: true) }

  private func manipulate(_ gesture: UIPanGestureRecognizer, resize: Bool) {
    guard let id = gesture.view?.accessibilityIdentifier,
          let index = regions.firstIndex(where: { $0.id == id }) else { return }
    if gesture.state == .began { selectedID = id; startRegions = regions; startPoint = gesture.location(in: overlay) }
    let translation = gesture.translation(in: overlay)
    guard let originalFrame = pageRect(startRegions[index].rect) else { return }
    var frame = originalFrame
    if resize { frame.size.width = max(24, originalFrame.width + translation.x); frame.size.height = max(24, originalFrame.height + translation.y) }
    else { frame.origin.x += translation.x; frame.origin.y += translation.y }
    frame.origin.x = max(0, min(bounds.width - frame.width, frame.origin.x))
    frame.origin.y = max(0, min(bounds.height - frame.height, frame.origin.y))
    guard let normalized = normalizedRect(frame) else { return }
    regions[index].rect = normalized
    layoutRegions()
    if gesture.state == .ended || gesture.state == .cancelled {
      history.append(startRegions); future.removeAll(); emit()
    }
  }

  @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
    let minimum = pdfView.minScaleFactor
    if pdfView.scaleFactor > minimum * 1.2 { pdfView.scaleFactor = minimum }
    else { pdfView.scaleFactor = min(pdfView.maxScaleFactor, minimum * 2.5) }
  }

  @objc private func pdfGeometryChanged() { layoutRegions() }

  private func emit() {
    onRedactionsChange(["pageIndex": pageIndex, "redactions": regions.map {
      ["id": $0.id, "rect": ["x": $0.rect.minX, "y": $0.rect.minY, "width": $0.rect.width, "height": $0.rect.height]]
    }, "canUndo": !history.isEmpty, "canRedo": !future.isEmpty])
  }
}

public enum AlytePDFWorkspaceTestSupport {
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
}
