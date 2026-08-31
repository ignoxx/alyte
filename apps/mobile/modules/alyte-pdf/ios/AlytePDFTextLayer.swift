import Foundation
import NaturalLanguage
import PDFKit

/// Versioned, page-scoped output from the deterministic PDFKit text-layer adapter.
///
/// This file intentionally has no Expo dependency. The result is still an untrusted source
/// observation: it is decoded again at the JavaScript boundary before entering extraction.
let alytePDFTextLayerAdapterVersion = "alyte.pdf.text-layer.v3"

let alytePDFTextLayerMaximumCharacters = 64 * 1024
let alytePDFTextLayerMaximumObservations = 512
let alytePDFTextLayerMaximumCells = 4096
let alytePDFTextLayerMaximumResponseBytes = 512 * 1024

private let alytePDFModelSupportedLanguages: Set<NLLanguage> = [.english, .german]

/// Returns a launch-supported language only when Natural Language has enough page-level evidence.
/// Unknown, mixed, and unsupported pages intentionally remain nil so model refinement never claims
/// a language from the device locale while deterministic source extraction can still continue.
func alytePDFSupportedLanguageHypothesis(
  _ hypotheses: [NLLanguage: Double]
) -> String? {
  let ranked = hypotheses.sorted {
    $0.value == $1.value ? $0.key.rawValue < $1.key.rawValue : $0.value > $1.value
  }
  guard let first = ranked.first,
    alytePDFModelSupportedLanguages.contains(first.key),
    first.value >= 0.50,
    first.value - (ranked.dropFirst().first?.value ?? 0) >= 0.15
  else { return nil }
  return first.key.rawValue
}

func alytePDFSupportedLanguage(_ text: String) -> String? {
  let letters = text.unicodeScalars.reduce(into: 0) { count, scalar in
    if CharacterSet.letters.contains(scalar) { count += 1 }
  }
  guard letters >= 24 else { return nil }
  let recognizer = NLLanguageRecognizer()
  // A bounded prefix is sufficient for a page language decision and prevents unusual PDFs from
  // turning language detection into unbounded work. The source string itself is never changed.
  recognizer.processString(String(text.prefix(16 * 1024)))
  return alytePDFSupportedLanguageHypothesis(
    recognizer.languageHypotheses(withMaximum: 3)
  )
}

struct AlytePDFTextGlyph {
  /// PDFKit character offsets are NSString (UTF-16) offsets.
  let range: NSRange
  let text: String
  /// Nil means that PDFKit did not provide a safe box for every UTF-16 code unit in this glyph.
  let bounds: CGRect?
  let visible: Bool
}

struct AlytePDFTextLine {
  var glyphs: [AlytePDFTextGlyph]
  var bounds: CGRect
  let sourceRange: NSRange?
}

struct AlytePDFTextCell {
  let range: NSRange
  let bounds: CGRect
}

private func alytePDFValidGeometry(_ rect: CGRect, in pageBounds: CGRect) -> Bool {
  guard pageBounds.width > 0, pageBounds.height > 0,
    rect.minX.isFinite, rect.minY.isFinite, rect.width.isFinite, rect.height.isFinite,
    rect.width > 0, rect.height > 0
  else { return false }
  return pageBounds.contains(rect)
}

private func alytePDFUnion(_ rects: [CGRect]) -> CGRect? {
  guard let first = rects.first else { return nil }
  return rects.dropFirst().reduce(first) { $0.union($1) }
}

private func alytePDFVisible(_ text: String) -> Bool {
  !text.isEmpty && text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
}

private func alytePDFNormalizedBox(_ rect: CGRect) -> [String: Double]? {
  // Character bounds were checked against mediaBox before this conversion. Keep a very small
  // tolerance for floating-point edge noise, then clamp only that noise; real out-of-page boxes
  // never cross the bridge.
  let epsilon: CGFloat = 0.000001
  guard rect.minX.isFinite, rect.minY.isFinite, rect.width.isFinite, rect.height.isFinite,
    rect.width > 0, rect.height > 0,
    rect.minX >= -epsilon, rect.minY >= -epsilon,
    rect.maxX <= 1 + epsilon, rect.maxY <= 1 + epsilon
  else { return nil }
  let x = min(1, max(0, rect.minX))
  let y = min(1, max(0, rect.minY))
  let maxX = min(1, max(0, rect.maxX))
  let maxY = min(1, max(0, rect.maxY))
  guard x < maxX, y < maxY else { return nil }
  return [
    "x": Double(x), "y": Double(y),
    "width": Double(maxX - x), "height": Double(maxY - y),
  ]
}

/// Converts mediaBox coordinates (whose origin may be non-zero and whose y-axis points up) into
/// the normalized top-left coordinates consumed by Vision and the domain geometry layer.
func alytePDFDisplayRect(
  _ rect: CGRect, pageBounds: CGRect, rotation: Int
) -> CGRect? {
  guard alytePDFValidGeometry(rect, in: pageBounds) else { return nil }
  let base = CGRect(
    x: (rect.minX - pageBounds.minX) / pageBounds.width,
    y: 1 - (rect.maxY - pageBounds.minY) / pageBounds.height,
    width: rect.width / pageBounds.width,
    height: rect.height / pageBounds.height
  )
  switch rotation {
  case 0: return base
  case 90:
    return CGRect(
      x: 1 - base.minY - base.height, y: base.minX,
      width: base.height, height: base.width
    )
  case 180:
    return CGRect(
      x: 1 - base.minX - base.width, y: 1 - base.minY - base.height,
      width: base.width, height: base.height
    )
  case 270:
    return CGRect(
      x: base.minY, y: 1 - base.minX - base.width,
      width: base.height, height: base.width
    )
  default: return nil
  }
}

func alytePDFTextGlyphs(
  page: PDFPage, source: NSString, pageBounds: CGRect, rotation: Int,
  selectionBounds: ((NSRange) -> CGRect?)? = nil
) -> [AlytePDFTextGlyph]? {
  // PDFKit's numberOfCharacters and page.string are both NSString-indexed. Requiring equality
  // prevents a stale or malformed source wall from being paired with unrelated character boxes.
  guard source.length > 0, source.length == page.numberOfCharacters,
    source.length <= alytePDFTextLayerMaximumCharacters
  else { return nil }

  var glyphs: [AlytePDFTextGlyph] = []
  glyphs.reserveCapacity(source.length)
  var offset = 0
  while offset < source.length {
    // Keep composed characters intact. The emitted ranges remain exact UTF-16 half-open ranges.
    let range = source.rangeOfComposedCharacterSequence(at: offset)
    guard range.location == offset, range.length > 0, NSMaxRange(range) <= source.length else {
      return nil
    }
    let text = source.substring(with: range)
    let visible = alytePDFVisible(text)
    let bounds: CGRect?
    if !visible {
      bounds = nil
    } else if let selectionBounds {
      guard let rect = selectionBounds(range), alytePDFValidGeometry(rect, in: pageBounds),
        let displayRect = alytePDFDisplayRect(
          rect, pageBounds: pageBounds, rotation: rotation)
      else { return nil }
      bounds = displayRect
    } else {
      var boundedRects: [CGRect] = []
      boundedRects.reserveCapacity(range.length)
      for characterOffset in range.location..<NSMaxRange(range) {
        let rect = page.characterBounds(at: characterOffset)
        guard rect.minX.isFinite, rect.minY.isFinite, rect.width.isFinite,
          rect.height.isFinite
        else { return nil }
        if alytePDFValidGeometry(rect, in: pageBounds),
          let displayRect = alytePDFDisplayRect(
            rect, pageBounds: pageBounds, rotation: rotation)
        {
          boundedRects.append(displayRect)
        }
      }
      // A composed glyph is bounded only when every UTF-16 code unit has safe geometry. A partial
      // bound is treated as unbounded and may survive only inside a later proven cell range.
      bounds = boundedRects.count == range.length ? alytePDFUnion(boundedRects) : nil
    }
    glyphs.append(
      AlytePDFTextGlyph(range: range, text: text, bounds: bounds, visible: visible))
    offset = NSMaxRange(range)
  }
  return glyphs
}

private func alytePDFVisibleGlyphRanges(_ source: NSString) -> [NSRange] {
  var ranges: [NSRange] = []
  var offset = 0
  while offset < source.length {
    let range = source.rangeOfComposedCharacterSequence(at: offset)
    ranges.append(range)
    offset = NSMaxRange(range)
  }
  return ranges.filter { alytePDFVisible(source.substring(with: $0)) }
}

/// Validates line ranges supplied by a single full-page PDFSelection. The source's composed
/// ranges, not a normalized String search, are the only authority for coverage and boundaries.
func alytePDFValidatedTextLineRanges(source: NSString, lineRanges: [NSRange]) -> [NSRange]? {
  guard !lineRanges.isEmpty else { return nil }
  let sorted = lineRanges.sorted {
    $0.location == $1.location ? $0.length < $1.length : $0.location < $1.location
  }
  var previousEnd = 0
  for range in sorted {
    guard range.location != NSNotFound, range.location >= 0, range.location <= source.length,
      range.length > 0, range.length <= source.length - range.location,
      range.location >= previousEnd,
      source.rangeOfComposedCharacterSequence(at: range.location).location == range.location,
      NSMaxRange(source.rangeOfComposedCharacterSequence(at: range.location + range.length - 1))
        == range.location + range.length
    else { return nil }
    previousEnd = range.location + range.length
  }

  let visibleGlyphs = alytePDFVisibleGlyphRanges(source)
  guard visibleGlyphs.count >= 8 else { return nil }
  for glyphRange in visibleGlyphs {
    let containing = sorted.filter {
      $0.location <= glyphRange.location && NSMaxRange(glyphRange) <= NSMaxRange($0)
    }
    guard containing.count == 1 else { return nil }
  }
  // A line selection containing no visible glyphs is a harmless blank line. It cannot emit an
  // observation, but retaining it here would force an empty observation later.
  let visibleLines = sorted.filter { line in
    visibleGlyphs.contains {
      line.location <= $0.location && NSMaxRange($0) <= NSMaxRange(line)
    }
  }
  return visibleLines.isEmpty ? nil : visibleLines
}

private enum AlytePDFLineSelectionResult {
  case unavailable
  case invalid
  case ranges([NSRange])
}

private func alytePDFSelectionLineRanges(
  page: PDFPage, source: NSString
) -> AlytePDFLineSelectionResult {
  guard let selection = page.selection(for: NSRange(location: 0, length: source.length)) else {
    return .unavailable
  }
  var lineRanges: [NSRange] = []
  for line in selection.selectionsByLine() {
    guard line.numberOfTextRanges(on: page) == 1 else { return .invalid }
    lineRanges.append(line.range(at: 0, on: page))
  }
  guard let validated = alytePDFValidatedTextLineRanges(source: source, lineRanges: lineRanges)
  else {
    return .invalid
  }
  return .ranges(validated)
}

/// Recovers only the missing visible glyph boxes after the original characterBounds coverage
/// threshold has passed. Each recovery query uses the glyph's exact UTF-16 range.
func alytePDFRecoverUnboundedGlyphs(
  _ glyphs: [AlytePDFTextGlyph],
  pageBounds: CGRect,
  rotation: Int,
  selectionBounds: (NSRange) -> CGRect?
) -> [AlytePDFTextGlyph]? {
  let visibleCount = glyphs.filter(\.visible).count
  let boundedCount = glyphs.filter { $0.visible && $0.bounds != nil }.count
  guard visibleCount >= 8, boundedCount * 100 >= visibleCount * 80 else { return nil }
  var recovered = glyphs
  for index in recovered.indices where recovered[index].visible && recovered[index].bounds == nil {
    let glyph = recovered[index]
    guard let selectionRect = selectionBounds(glyph.range),
      alytePDFValidGeometry(selectionRect, in: pageBounds),
      let displayRect = alytePDFDisplayRect(
        selectionRect, pageBounds: pageBounds, rotation: rotation
      )
    else { return nil }
    recovered[index] = AlytePDFTextGlyph(
      range: glyph.range, text: glyph.text, bounds: displayRect, visible: glyph.visible
    )
  }
  return recovered
}

private func alytePDFExactLineGroups(
  _ glyphs: [AlytePDFTextGlyph], ranges: [NSRange]
) -> [AlytePDFTextLine]? {
  var lines: [AlytePDFTextLine] = []
  for range in ranges {
    let lineGlyphs = glyphs.filter {
      range.location <= $0.range.location && NSMaxRange($0.range) <= NSMaxRange(range)
    }
    let visibleGlyphs = lineGlyphs.filter(\.visible)
    guard !visibleGlyphs.isEmpty,
      visibleGlyphs.allSatisfy({ $0.bounds != nil }),
      let bounds = alytePDFUnion(visibleGlyphs.compactMap(\.bounds))
    else { return nil }
    lines.append(AlytePDFTextLine(glyphs: lineGlyphs, bounds: bounds, sourceRange: range))
  }
  return lines.isEmpty ? nil : lines
}

private func alytePDFBandMatches(_ left: CGRect, _ right: CGRect, height: CGFloat) -> Bool {
  let overlap = left.intersection(right)
  let verticalOverlap = overlap.isNull ? 0 : overlap.height
  let overlapRatio = verticalOverlap / max(0.000001, min(left.height, right.height))
  let baselineDistance = abs(left.midY - right.midY)
  return overlapRatio >= 0.2 || baselineDistance <= height * 0.7
}

private func alytePDFMedian(_ values: [CGFloat]) -> CGFloat {
  guard !values.isEmpty else { return 0 }
  let sorted = values.sorted()
  return sorted[sorted.count / 2]
}

private func alytePDFLineGroups(_ glyphs: [AlytePDFTextGlyph]) -> [AlytePDFTextLine]? {
  let visible = glyphs.filter(\.visible)
  let boundedVisible = visible.filter { $0.bounds != nil }
  guard visible.count >= 8, boundedVisible.count * 100 >= visible.count * 80 else { return nil }
  let medianHeight = alytePDFMedian(boundedVisible.compactMap { $0.bounds?.height })
  guard medianHeight > 0 else { return nil }

  var lines: [AlytePDFTextLine] = []
  for glyph in boundedVisible {
    guard let bounds = glyph.bounds else { return nil }
    let matches = lines.indices.filter {
      alytePDFBandMatches(lines[$0].bounds, bounds, height: medianHeight)
    }
    // A glyph that plausibly belongs to two visual bands means the whole page is ambiguous.
    guard matches.count <= 1 else { return nil }
    if let index = matches.first {
      lines[index].glyphs.append(glyph)
      lines[index].bounds = lines[index].bounds.union(bounds)
    } else {
      lines.append(AlytePDFTextLine(glyphs: [glyph], bounds: bounds, sourceRange: nil))
    }
  }
  guard !lines.isEmpty else { return nil }

  // Unbounded visible glyphs cannot establish a row. Keep one only when the immediately
  // surrounding visible glyphs are bounded and belong to the same visual line. The cell pass
  // below applies the stricter contiguous-cell rule before the character can cross the bridge.
  for glyphIndex in glyphs.indices
  where glyphs[glyphIndex].visible && glyphs[glyphIndex].bounds == nil {
    let previousIndex = glyphs[..<glyphIndex].lastIndex {
      $0.visible && $0.bounds != nil
    }
    let nextIndex = glyphs[(glyphIndex + 1)..<glyphs.count].firstIndex {
      $0.visible && $0.bounds != nil
    }
    guard let previousIndex, let nextIndex else { return nil }
    let previous = glyphs[previousIndex]
    let next = glyphs[nextIndex]
    let previousLines = lines.indices.filter {
      lines[$0].glyphs.contains { $0.range == previous.range }
    }
    let nextLines = lines.indices.filter { lines[$0].glyphs.contains { $0.range == next.range } }
    guard previousLines.count == 1, nextLines.count == 1, previousLines[0] == nextLines[0] else {
      return nil
    }
    lines[previousLines[0]].glyphs.append(glyphs[glyphIndex])
  }

  // Layout grouping can never alter source order. Sorting is deterministic; the final range
  // validation rejects any interleaving or overlap produced by a future grouping change.
  lines.sort {
    ($0.glyphs.map(\.range.location).min() ?? Int.max)
      < ($1.glyphs.map(\.range.location).min() ?? Int.max)
  }
  for index in lines.indices {
    lines[index].glyphs.sort { $0.range.location < $1.range.location }
    var priorX: CGFloat?
    for glyph in lines[index].glyphs where glyph.visible {
      guard let bounds = glyph.bounds else { continue }
      // A source line whose bounded glyphs move backwards in displayed x is not a safe cell
      // projection. A tiny tolerance absorbs floating-point noise at a shared edge only.
      if let priorX, bounds.minX + 0.000001 < priorX { return nil }
      priorX = bounds.minX
    }
  }
  return lines
}

func alytePDFCells(
  line: AlytePDFTextLine, medianHeight: CGFloat, splitXResets: Bool = true
) -> [AlytePDFTextCell]? {
  let bounded = line.glyphs.filter { $0.visible && $0.bounds != nil }
  guard !bounded.isEmpty else { return nil }
  let medianGlyphWidth = alytePDFMedian(bounded.compactMap { $0.bounds?.width })
  guard medianGlyphWidth > 0 else { return nil }
  let gapLimit = max(medianGlyphWidth * 2.2, 0.006)
  guard
    var cells = alytePDFSplitCells(
      bounded, gapLimit: gapLimit, medianHeight: medianHeight, splitXResets: splitXResets
    )
  else { return nil }

  // Some PDF text layers pack a dense table row into one source fragment even though its glyphs
  // retain real inter-column gaps. Re-segment only a wide, bounded measurement-shaped fragment.
  // The emitted fields remain exact source slices; this does not parse or map their meaning.
  if splitXResets {
    let lineMedianCellWidth = alytePDFMedian(cells.map(\.bounds.width))
    var refined: [AlytePDFTextCell] = []
    for cell in cells {
      let glyphs = line.glyphs.filter {
        cell.range.location <= $0.range.location && NSMaxRange($0.range) <= NSMaxRange(cell.range)
      }
      let text = glyphs.map(\.text).joined()
      let eligible =
        cell.bounds.width >= 0.05
        && cell.bounds.width >= lineMedianCellWidth
        && text.rangeOfCharacter(from: .whitespacesAndNewlines) != nil
        && text.rangeOfCharacter(from: .letters) != nil
        && text.rangeOfCharacter(from: .decimalDigits) != nil
        && alytePDFNumericTokenCount(text) <= 3
      if eligible,
        let split = alytePDFSplitCells(
          glyphs.filter { $0.visible && $0.bounds != nil },
          gapLimit: 0.002,
          medianHeight: medianHeight,
          splitXResets: true
        ), split.count > 1
      {
        refined.append(contentsOf: split)
      } else {
        refined.append(cell)
      }
    }
    cells = refined
  }

  guard cells.allSatisfy({ alytePDFNormalizedBox($0.bounds) != nil }) else { return nil }

  // An unbounded visible character may be retained only by a single exact cell range. If it is
  // between two visual cells, emitting the page would silently drop it from the source cell.
  for glyph in line.glyphs where glyph.visible && glyph.bounds == nil {
    let containing = cells.filter {
      $0.range.location <= glyph.range.location && NSMaxRange(glyph.range) <= NSMaxRange($0.range)
    }
    guard containing.count == 1 else { return nil }
  }
  return cells
}

private func alytePDFSplitCells(
  _ bounded: [AlytePDFTextGlyph], gapLimit: CGFloat, medianHeight: CGFloat,
  splitXResets: Bool
) -> [AlytePDFTextCell]? {
  guard !bounded.isEmpty, gapLimit >= 0, medianHeight > 0 else { return nil }
  var cells: [AlytePDFTextCell] = []
  var first = bounded[0]
  var last = bounded[0]
  var bounds = first.bounds!
  var previousGlyph = first
  for glyph in bounded.dropFirst() {
    guard let glyphBounds = glyph.bounds else { return nil }
    // Exact PDFSelection lines can preserve the PDF content stream's visual fragments in source
    // order, so a prior reset must not let the cumulative union hide a later column gap. The
    // fallback remains cumulative because its monotonic-x guard has already proven that geometry
    // follows source order.
    let gapBase = splitXResets ? bounds.maxX : previousGlyph.bounds!.maxX
    let gap = glyphBounds.minX - gapBase
    let resetTolerance = max(medianHeight * 0.25, 0.002)
    let xReset = glyphBounds.minX + resetTolerance < previousGlyph.bounds!.minX
    if gap > gapLimit || (splitXResets && xReset) {
      cells.append(
        AlytePDFTextCell(
          range: NSRange(
            location: first.range.location,
            length: NSMaxRange(last.range) - first.range.location
          ),
          bounds: bounds
        ))
      first = glyph
      last = glyph
      bounds = glyphBounds
    } else {
      last = glyph
      bounds = bounds.union(glyphBounds)
    }
    previousGlyph = glyph
  }
  cells.append(
    AlytePDFTextCell(
      range: NSRange(
        location: first.range.location,
        length: NSMaxRange(last.range) - first.range.location
      ),
      bounds: bounds
    ))
  return cells
}

private func alytePDFNumericTokenCount(_ text: String) -> Int {
  var count = 0
  var insideNumber = false
  var usedDecimalSeparator = false
  for character in text {
    if character.isNumber {
      if !insideNumber { count += 1 }
      insideNumber = true
      usedDecimalSeparator = false
    } else if insideNumber && (character == "." || character == ",")
      && !usedDecimalSeparator
    {
      usedDecimalSeparator = true
    } else {
      insideNumber = false
      usedDecimalSeparator = false
    }
  }
  return count
}

func alytePDFTextLayerObservation(
  source: NSString,
  line: AlytePDFTextLine,
  cells: [AlytePDFTextCell],
  pageIndex: Int,
  language: String? = nil
) -> [String: Any]? {
  guard let first = line.glyphs.first, let last = line.glyphs.last,
    let lineBounds = alytePDFUnion(line.glyphs.compactMap { $0.bounds }),
    let lineBox = alytePDFNormalizedBox(lineBounds)
  else { return nil }
  let lineRange =
    line.sourceRange
    ?? NSRange(
      location: first.range.location, length: NSMaxRange(last.range) - first.range.location)
  guard lineRange.location >= 0, NSMaxRange(lineRange) <= source.length else { return nil }
  let lineText = source.substring(with: lineRange)
  guard !lineText.isEmpty else { return nil }
  let id = "pdf-\(pageIndex)-line-\(lineRange.location)-\(NSMaxRange(lineRange))"
  var spans: [[String: Any]] = []
  var previousCellEnd = lineRange.location
  for cell in cells {
    guard cell.range.location >= lineRange.location,
      NSMaxRange(cell.range) <= NSMaxRange(lineRange),
      cell.range.location >= previousCellEnd,
      let box = alytePDFNormalizedBox(cell.bounds)
    else { return nil }
    let exact = source.substring(with: cell.range)
    let start = cell.range.location - lineRange.location
    let end = NSMaxRange(cell.range) - lineRange.location
    guard start >= 0, start < end, end <= lineText.utf16.count,
      exact == (lineText as NSString).substring(with: NSRange(location: start, length: end - start))
    else { return nil }
    let spanID = "pdf-\(pageIndex)-span-\(cell.range.location)-\(NSMaxRange(cell.range))"
    spans.append([
      "id": spanID,
      "parentObservationId": id,
      "start": start,
      "end": end,
      "text": exact,
      "boundingBox": box,
    ])
    previousCellEnd = NSMaxRange(cell.range)
  }
  guard !spans.isEmpty else { return nil }
  let recognitionLanguage: Any = language.map { $0 as Any } ?? NSNull()
  return [
    "id": id,
    "text": lineText,
    "sourceStart": lineRange.location,
    "sourceEnd": NSMaxRange(lineRange),
    "alternatives": [],
    "boundingBox": lineBox,
    "pageIndex": pageIndex,
    "orientation": 0,
    "structure": [
      "kind": "text", "tableId": NSNull(), "rowIndex": NSNull(), "columnIndex": NSNull(),
    ],
    "spans": spans,
    "recognition": [
      "level": "accurate", "language": recognitionLanguage, "internalConfidence": NSNull(),
    ],
  ]
}

/// Returns one complete, source-ordered page envelope or nil when PDFKit cannot prove a safe
/// text-layer projection. Nil is the only normal fallback signal; malformed paths and locked
/// documents remain errors at the module boundary.
func alytePDFTextLayerPage(document: PDFDocument, pageIndex: Int) -> [String: Any]? {
  guard !document.isLocked, pageIndex >= 0, pageIndex < document.pageCount,
    let page = document.page(at: pageIndex), let rawString = page.string
  else { return nil }
  let pageBounds = page.bounds(for: .mediaBox)
  guard pageBounds.width > 0, pageBounds.height > 0 else { return nil }
  let normalizedRotation = ((page.rotation % 360) + 360) % 360
  guard [0, 90, 180, 270].contains(normalizedRotation) else { return nil }
  let source = rawString as NSString
  let language = alytePDFSupportedLanguage(rawString)
  let lines: [AlytePDFTextLine]
  let glyphs: [AlytePDFTextGlyph]
  let splitSourceOrderXResets: Bool
  switch alytePDFSelectionLineRanges(page: page, source: source) {
  case .unavailable:
    guard
      let fallbackGlyphs = alytePDFTextGlyphs(
        page: page, source: source, pageBounds: pageBounds,
        rotation: normalizedRotation)
    else { return nil }
    glyphs = fallbackGlyphs
    guard let fallbackLines = alytePDFLineGroups(glyphs) else { return nil }
    lines = fallbackLines
    // Geometry fallback has already proven monotonically increasing displayed x.
    splitSourceOrderXResets = false
  case .invalid:
    return nil
  case .ranges(let ranges):
    guard
      let exactGlyphs = alytePDFTextGlyphs(
        page: page,
        source: source,
        pageBounds: pageBounds,
        rotation: normalizedRotation,
        selectionBounds: { range in
          page.selection(for: range)?.bounds(for: page)
        }),
      let exactLines = alytePDFExactLineGroups(exactGlyphs, ranges: ranges)
    else { return nil }
    glyphs = exactGlyphs
    lines = exactLines
    // PDFSelection preserves source order, which can jump back to an earlier displayed x within
    // one logical line. Keep those fragments as distinct exact source cells; otherwise the first
    // fragment's cumulative box can swallow later column gaps and destroy table geometry.
    splitSourceOrderXResets = true
  }
  let medianHeight = alytePDFMedian(glyphs.compactMap { $0.visible ? $0.bounds?.height : nil })
  guard medianHeight > 0 else { return nil }

  var observations: [[String: Any]] = []
  var cellsCount = 0
  for line in lines {
    guard
      let cells = alytePDFCells(
        line: line, medianHeight: medianHeight, splitXResets: splitSourceOrderXResets),
      cellsCount + cells.count <= alytePDFTextLayerMaximumCells,
      let observation = alytePDFTextLayerObservation(
        source: source, line: line, cells: cells, pageIndex: pageIndex, language: language
      )
    else { return nil }
    cellsCount += cells.count
    observations.append(observation)
  }
  guard !observations.isEmpty, observations.count <= alytePDFTextLayerMaximumObservations else {
    return nil
  }

  // Atomic page validation: every emitted parent range is exact, non-overlapping, and in source
  // order; every visible source glyph is covered once. Whitespace outside a cell remains inside
  // its bounded parent text but is not manufactured into a standalone observation.
  var previousObservationEnd = 0
  var observationIDs = Set<String>()
  var allSpanIDs = Set<String>()
  for observation in observations {
    guard let id = observation["id"] as? String,
      let start = observation["sourceStart"] as? Int,
      let end = observation["sourceEnd"] as? Int,
      start >= previousObservationEnd, start < end, end <= source.length,
      observationIDs.insert(id).inserted,
      let text = observation["text"] as? String,
      text == source.substring(with: NSRange(location: start, length: end - start))
    else { return nil }
    previousObservationEnd = end

    guard let spans = observation["spans"] as? [[String: Any]], !spans.isEmpty else { return nil }
    var previousSpanEnd = 0
    var spanIDs = Set<String>()
    for span in spans {
      guard let spanID = span["id"] as? String,
        let spanStart = span["start"] as? Int,
        let spanEnd = span["end"] as? Int,
        spanStart >= 0, spanStart < spanEnd, spanEnd <= text.utf16.count,
        spanIDs.insert(spanID).inserted, allSpanIDs.insert(spanID).inserted,
        spanStart >= previousSpanEnd,
        span["parentObservationId"] as? String == id,
        let spanText = span["text"] as? String,
        spanText
          == (text as NSString).substring(
            with: NSRange(location: spanStart, length: spanEnd - spanStart)),
        alytePDFIsComposedBoundary(text as NSString, offset: spanStart),
        alytePDFIsComposedBoundary(text as NSString, offset: spanEnd)
      else { return nil }
      previousSpanEnd = spanEnd
    }
  }
  for glyph in glyphs where glyph.visible {
    let containingCells = observations.flatMap { observation -> [[String: Any]] in
      guard let start = observation["sourceStart"] as? Int,
        let spans = observation["spans"] as? [[String: Any]],
        let text = observation["text"] as? String
      else { return [] }
      return spans.compactMap { span in
        guard let spanStart = span["start"] as? Int,
          let spanEnd = span["end"] as? Int,
          spanStart >= 0, spanEnd <= text.utf16.count
        else { return nil }
        let absoluteStart = start + spanStart
        let absoluteEnd = start + spanEnd
        return absoluteStart <= glyph.range.location && NSMaxRange(glyph.range) <= absoluteEnd
          ? span : nil
      }
    }
    guard containingCells.count == 1 else { return nil }
  }

  let result: [String: Any] = [
    "contractVersion": alytePDFTextLayerAdapterVersion,
    "pageIndex": pageIndex,
    // Boxes are already in Vision's top-left coordinates.
    "orientation": 0,
    "observations": observations,
  ]
  // JSON serialization is a final bounded-output guard. Never truncate a page to fit.
  guard JSONSerialization.isValidJSONObject(result),
    let data = try? JSONSerialization.data(withJSONObject: result, options: []),
    data.count <= alytePDFTextLayerMaximumResponseBytes
  else { return nil }
  return result
}

private func alytePDFIsComposedBoundary(_ source: NSString, offset: Int) -> Bool {
  guard offset >= 0, offset <= source.length else { return false }
  if offset == 0 || offset == source.length { return true }
  // A UTF-16 span may not split a composed character (including a surrogate pair). This is
  // intentionally based on NSString ranges, never substring search or normalized text.
  let preceding = source.rangeOfComposedCharacterSequence(at: offset - 1)
  return NSMaxRange(preceding) <= offset
}
