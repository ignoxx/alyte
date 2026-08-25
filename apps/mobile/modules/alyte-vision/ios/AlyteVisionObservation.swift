import Foundation
import Vision

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
  lines: [RecognizedTextObservation]
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
      lines: lines
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
      lines: [line]
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
  lines: [RecognizedTextObservation]
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
  return [
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
}
