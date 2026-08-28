import Foundation
import Vision

/// The span limits are deliberately conservative. They bound both the amount of OCR provenance
/// crossing the Expo bridge and the work needed to validate it later. Exceeding either limit keeps
/// the complete parent observation and omits only its optional spans.
let alyteVisionMaxTokenSpansPerObservation = 128
let alyteVisionMaxTokenParentCharactersPerObservation = 8 * 1024
let alyteVisionMaxTokenSpanSerializedBytesPerObservation = 16 * 1024
let alyteVisionMaxTokenSpanSerializedBytesPerPage = 256 * 1024

struct AlyteVisionTokenCandidate {
  let text: String
  let boundingBox: CGRect
}

/// Emits one source observation per geometrically independent Vision line when Vision provides
/// exact line regions. If the regions cannot prove a safe split, the original observation is kept
/// intact so OCR never invents a boundary between laboratory rows.
func alyteDocumentObservations(
  id: String,
  text: String,
  box: CGRect,
  pageIndex: Int,
  orientation: Int,
  structure: [String: Any],
  lines: [RecognizedTextObservation],
  words: [RecognizedTextObservation]? = nil
) -> [[String: Any]] {
  let splitLines = alyteSafelySeparatedLines(lines, inside: box)
  if splitLines.count <= 1 {
    return [alyteDocumentObservation(
      id: id,
      text: text,
      box: box,
      pageIndex: pageIndex,
      orientation: orientation,
      structure: structure,
      lines: lines,
      words: words
    )]
  }

  let lineStructure: [String: Any] = [
    "kind": "text",
    "tableId": NSNull(),
    "rowIndex": NSNull(),
    "columnIndex": NSNull(),
  ]
  return splitLines.enumerated().map { index, line in
    alyteDocumentObservation(
      id: "\(id)-line-\(index)",
      text: line.transcript,
      box: line.boundingBox.cgRect,
      pageIndex: pageIndex,
      orientation: orientation,
      structure: lineStructure,
      lines: [line],
      words: alyteWords(in: line.boundingBox.cgRect, from: words)
    )
  }
}

func alyteSafelySeparatedLines(
  _ lines: [RecognizedTextObservation],
  inside box: CGRect
) -> [RecognizedTextObservation] {
  guard lines.count > 1,
    lines.allSatisfy({ !$0.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
  else { return [] }
  let lineBoxes = lines.map(\.boundingBox.cgRect)
  guard lineBoxes.allSatisfy({
    $0.width > 0 && $0.height > 0 && box.contains($0)
  }) else { return [] }
  for firstIndex in lineBoxes.indices {
    for secondIndex in lineBoxes.indices where secondIndex > firstIndex {
      if lineBoxes[firstIndex].intersects(lineBoxes[secondIndex]) { return [] }
    }
  }
  return lines.enumerated()
    .sorted { first, second in
      let firstBox = first.element.boundingBox.cgRect
      let secondBox = second.element.boundingBox.cgRect
      if firstBox.maxY != secondBox.maxY { return firstBox.maxY > secondBox.maxY }
      if firstBox.minX != secondBox.minX { return firstBox.minX < secondBox.minX }
      return first.offset < second.offset
    }
    .map(\.element)
}

private func alyteDocumentObservation(
  id: String,
  text: String,
  box: CGRect,
  pageIndex: Int,
  orientation: Int,
  structure: [String: Any],
  lines: [RecognizedTextObservation],
  words: [RecognizedTextObservation]? = nil
) -> [String: Any] {
  let language: Any = lines.first?.recognitionLanguages.first?.minimalIdentifier as Any? ?? NSNull()
  let confidence: Any = lines.isEmpty
    ? NSNull()
    : Double(lines.map(\.confidence).reduce(0, +) / Float(lines.count))
  let x = max(0, min(1, box.minX))
  let y = max(0, min(1, 1 - box.maxY))
  let width = max(0.0001, min(1 - x, box.width))
  let height = max(0.0001, min(1 - y, box.height))
  let alternatives = Array(Set(lines.flatMap {
    $0.topCandidates(5).dropFirst().map(\.string)
  })).sorted().prefix(5).map { $0 }
  var observation: [String: Any] = [
    "id": id,
    "text": text,
    "alternatives": alternatives,
    "boundingBox": [
      "x": Double(x),
      "y": Double(y),
      "width": Double(width),
      "height": Double(height),
    ],
    "pageIndex": pageIndex,
    "orientation": orientation,
    "structure": structure,
    "recognition": [
      "level": "accurate",
      "language": language,
      "internalConfidence": confidence,
    ],
  ]
  if let spans = alyteDocumentTokenSpans(
    parentObservationId: id,
    text: text,
    words: words,
    lines: lines
  ) {
    observation["spans"] = spans
  }
  return observation
}

/// Returns the exact UTF-16 ranges represented by token candidates. The candidates are supplied
/// by Vision, never parsed or normalized here. A candidate is emitted only when its text occurs as
/// a complete exact substring of the parent observation and its geometry has positive area.
/// `start` is inclusive and `end` is exclusive, both measured in UTF-16 code units.
func alyteExactTokenSpans(
  parentObservationId: String,
  text: String,
  candidates: [AlyteVisionTokenCandidate]
) -> [[String: Any]]? {
  guard !text.isEmpty,
    text.utf16.count <= alyteVisionMaxTokenParentCharactersPerObservation,
    !candidates.isEmpty,
    candidates.count <= alyteVisionMaxTokenSpansPerObservation
  else {
    return nil
  }

  var cursor = 0
  var spans: [(start: Int, end: Int, text: String, box: [String: Double])] = []
  var ranges = Set<String>()
  for candidate in candidates {
    guard !candidate.text.isEmpty,
      !candidate.text.allSatisfy({ $0.isWhitespace }),
      let match = alyteExactSubstringRange(text, candidate.text, fromUTF16Offset: cursor)
    else { continue }
    cursor = match.end
    guard let box = alyteNormalizedTokenBox(candidate.boundingBox) else { continue }
    let key = "\(match.start):\(match.end)"
    guard ranges.insert(key).inserted else { continue }
    spans.append((match.start, match.end, String(text[match.range]), box))
    if spans.count > alyteVisionMaxTokenSpansPerObservation { return nil }
  }

  guard !spans.isEmpty else { return nil }
  let sorted = spans.sorted {
    if $0.start != $1.start { return $0.start < $1.start }
    return $0.end < $1.end
  }
  let result = sorted.map { span in
    [
      "id": "\(parentObservationId)-span-\(span.start)-\(span.end)",
      "parentObservationId": parentObservationId,
      "start": span.start,
      "end": span.end,
      "text": span.text,
      "boundingBox": span.box,
    ] as [String: Any]
  }
  guard alyteSerializedByteCount(result) <= alyteVisionMaxTokenSpanSerializedBytesPerObservation else {
    return nil
  }
  return result
}

/// Builds spans from the structured words attached to a DocumentObservation text container. This
/// is preferred because each word already has its own Vision geometry.
private func alyteDocumentTokenSpans(
  parentObservationId: String,
  text: String,
  words: [RecognizedTextObservation]?,
  lines: [RecognizedTextObservation]
) -> [[String: Any]]? {
  if let words, !words.isEmpty {
    let candidates = words.map {
      AlyteVisionTokenCandidate(text: $0.transcript, boundingBox: $0.boundingBox.cgRect)
    }
    if let spans = alyteExactTokenSpans(
      parentObservationId: parentObservationId,
      text: text,
      candidates: candidates
    ) {
      return spans
    }
  }

  // Vision may not provide words for a text container. Its recognized top candidate still exposes
  // a geometry query for an exact substring, which is safe to use without a second OCR request.
  var candidates: [AlyteVisionTokenCandidate] = []
  var parentCursor = 0
  for line in lines {
    guard let recognized = line.topCandidates(1).first else { continue }
    for token in alyteWhitespaceTokens(recognized.string) {
      guard let parentMatch = alyteExactSubstringRange(
        text,
        token.text,
        fromUTF16Offset: parentCursor
      ) else { continue }
      parentCursor = parentMatch.end
      guard let region = recognized.boundingBox(for: token.range) else { continue }
      candidates.append(
        AlyteVisionTokenCandidate(
          text: String(text[parentMatch.range]),
          boundingBox: region.boundingBox.cgRect
        )
      )
    }
  }
  return alyteExactTokenSpans(
    parentObservationId: parentObservationId,
    text: text,
    candidates: candidates
  )
}

func alyteWords(
  in lineBox: CGRect,
  from words: [RecognizedTextObservation]?
) -> [RecognizedTextObservation]? {
  guard let words else { return nil }
  let selected = words.filter { word in
    let box = word.boundingBox.cgRect
    let center = CGPoint(x: box.midX, y: box.midY)
    return box.width > 0 && box.height > 0 && box.intersects(lineBox) && lineBox.contains(center)
  }
  return selected.isEmpty ? nil : selected
}

private func alyteWhitespaceTokens(
  _ text: String
) -> [(text: String, range: Range<String.Index>)] {
  var tokens: [(text: String, range: Range<String.Index>)] = []
  var tokenStart: String.Index?
  var index = text.startIndex
  while index < text.endIndex {
    let next = text.index(after: index)
    if text[index].isWhitespace {
      if let tokenStart {
        tokens.append((String(text[tokenStart..<index]), tokenStart..<index))
      }
      tokenStart = nil
    } else if tokenStart == nil {
      tokenStart = index
    }
    index = next
  }
  if let tokenStart {
    tokens.append((String(text[tokenStart..<text.endIndex]), tokenStart..<text.endIndex))
  }
  return tokens
}

private func alyteExactSubstringRange(
  _ text: String,
  _ candidate: String,
  fromUTF16Offset offset: Int
) -> (start: Int, end: Int, range: Range<String.Index>)? {
  guard !candidate.isEmpty, offset >= 0, offset <= text.utf16.count else { return nil }
  let lowerBound = String.Index(utf16Offset: offset, in: text)
  guard let range = text.range(of: candidate, range: lowerBound..<text.endIndex) else { return nil }
  let before = range.lowerBound == text.startIndex ? nil : text[text.index(before: range.lowerBound)]
  let after = range.upperBound == text.endIndex ? nil : text[range.upperBound]
  guard before?.isWhitespace ?? true, after?.isWhitespace ?? true else { return nil }
  return (
    range.lowerBound.utf16Offset(in: text),
    range.upperBound.utf16Offset(in: text),
    range
  )
}

private func alyteNormalizedTokenBox(_ box: CGRect) -> [String: Double]? {
  guard box.minX.isFinite, box.minY.isFinite, box.width.isFinite, box.height.isFinite,
    box.width > 0, box.height > 0 else { return nil }
  let minX = max(0, min(1, box.minX))
  let maxX = max(0, min(1, box.maxX))
  let minY = max(0, min(1, box.minY))
  let maxY = max(0, min(1, box.maxY))
  guard maxX > minX, maxY > minY else { return nil }
  return [
    "x": Double(minX),
    "y": Double(1 - maxY),
    "width": Double(maxX - minX),
    "height": Double(maxY - minY),
  ]
}

private func alyteSerializedByteCount(_ value: Any) -> Int {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
    return Int.max
  }
  return data.count
}

/// Applies the page-wide serialized cap after all parent observations have been generated. A page
/// overflow is handled independently and deterministically: the overflowing parent keeps all v2
/// fields but loses only its optional `spans` entry.
func alyteApplyPageTokenSpanCap(
  _ observations: [[String: Any]]
) -> [[String: Any]] {
  var serializedBytes = 0
  return observations.map { observation in
    guard let spans = observation["spans"] as? [[String: Any]], !spans.isEmpty else {
      return observation
    }
    let spanBytes = alyteSerializedByteCount(spans)
    guard spanBytes <= alyteVisionMaxTokenSpanSerializedBytesPerObservation,
      spanBytes <= alyteVisionMaxTokenSpanSerializedBytesPerPage,
      serializedBytes <= alyteVisionMaxTokenSpanSerializedBytesPerPage - spanBytes else {
      var parentOnly = observation
      parentOnly.removeValue(forKey: "spans")
      return parentOnly
    }
    serializedBytes += spanBytes
    return observation
  }
}
