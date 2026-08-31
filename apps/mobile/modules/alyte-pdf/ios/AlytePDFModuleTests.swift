import Foundation
import NaturalLanguage
import PDFKit
import UIKit
import XCTest

final class AlytePDFModuleTests: XCTestCase {
  func testSelectableTextLanguageDetectionAcceptsOnlyClearLaunchLanguages() {
    XCTAssertEqual(
      alytePDFSupportedLanguageHypothesis([.english: 0.82, .german: 0.08]),
      "en"
    )
    XCTAssertEqual(
      alytePDFSupportedLanguageHypothesis([.german: 0.78, .english: 0.11]),
      "de"
    )
    XCTAssertNil(alytePDFSupportedLanguageHypothesis([.english: 0.49, .german: 0.02]))
    XCTAssertNil(alytePDFSupportedLanguageHypothesis([.english: 0.56, .german: 0.45]))
    XCTAssertNil(alytePDFSupportedLanguageHypothesis([.french: 0.91, .english: 0.04]))
  }

  func testSelectableTextLanguageDetectionRecognizesSyntheticEnglishAndGermanPages() {
    XCTAssertEqual(
      alytePDFSupportedLanguage(
        "Laboratory report. The measured result and reference interval are shown for each sample."
      ),
      "en"
    )
    XCTAssertEqual(
      alytePDFSupportedLanguage(
        "Laborbefund. Das gemessene Ergebnis und der Referenzbereich werden für jede Probe angezeigt."
      ),
      "de"
    )
    XCTAssertNil(alytePDFSupportedLanguage("LDL 118 mg/dL"))
  }

  func testPreviewBridgeContractIsAnArrayOfPageUris() {
    let pages: AlytePDFPreviewResult = [
      "data:image/png;base64,synthetic-page-1",
      "data:image/png;base64,synthetic-page-2",
    ]

    XCTAssertEqual(pages.count, 2)
    XCTAssertTrue(pages.allSatisfy { $0.hasPrefix("data:image/png;base64,") })
  }

  func testSyntheticPasswordPdfRejectsWrongPasswordAndAcceptsCorrectPassword() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-pdf-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let source = PDFDocument()
    source.insert(PDFPage(), at: 0)
    let url = directory.appendingPathComponent("password.pdf")
    let options: [PDFDocumentWriteOption: Any] = [
      .ownerPasswordOption: "synthetic-owner",
      .userPasswordOption: "synthetic-user",
    ]
    XCTAssertTrue(source.write(to: url, withOptions: options))

    let locked = try XCTUnwrap(PDFDocument(url: url))
    XCTAssertTrue(locked.isEncrypted)
    XCTAssertTrue(locked.isLocked)
    XCTAssertFalse(locked.unlock(withPassword: "wrong-password"))
    XCTAssertTrue(locked.isLocked)
    XCTAssertTrue(locked.unlock(withPassword: "synthetic-user"))
    XCTAssertFalse(locked.isLocked)
    XCTAssertNotNil(locked.page(at: 0))
  }

  func testUnreadablePdfIsNotReportedAsAValidPreviewSource() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-pdf-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let url = directory.appendingPathComponent("not-a-pdf.pdf")
    try Data("synthetic-not-pdf".utf8).write(to: url)

    XCTAssertNil(PDFDocument(url: url))
  }

  func testViewerSessionRetainsMixedPageGeometryUntilExplicitClose() throws {
    let document = PDFDocument()
    for size in [
      CGSize(width: 612, height: 792),
      CGSize(width: 792, height: 612),
      CGSize(width: 612, height: 792),
      CGSize(width: 792, height: 612),
    ] {
      let image = UIGraphicsImageRenderer(size: size).image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: size))
      }
      document.insert(try XCTUnwrap(PDFPage(image: image)), at: document.pageCount)
    }

    let sessionId = AlytePDFSessionStore.shared.insert(document)
    let session = try XCTUnwrap(AlytePDFSessionStore.shared.document(for: sessionId))
    XCTAssertEqual(session.pageCount, 4)
    XCTAssertEqual(
      session.page(at: 0)?.bounds(for: .mediaBox).size, CGSize(width: 612, height: 792))
    XCTAssertEqual(
      session.page(at: 1)?.bounds(for: .mediaBox).size, CGSize(width: 792, height: 612))

    AlytePDFSessionStore.shared.remove(sessionId)
    XCTAssertNil(AlytePDFSessionStore.shared.document(for: sessionId))
  }

  func testViewerSummaryDoesNotExposePageInspectionForLargeDocuments() throws {
    let document = PDFDocument()
    for index in 0..<4096 {
      document.insert(PDFPage(), at: index)
    }

    let result = try viewerSummary(document, sessionId: "synthetic-viewer")

    XCTAssertEqual(result["locked"] as? Bool, false)
    XCTAssertEqual(result["pageCount"] as? Int, 4096)
    XCTAssertEqual(result["sessionId"] as? String, "synthetic-viewer")
    XCTAssertNil(result["metadata"])
    XCTAssertNil(result["pages"])
  }

  func testAbandonedViewerSessionsExpireEvictAndReleaseIdempotently() {
    var clock = Date(timeIntervalSince1970: 1_000)
    let store = AlytePDFSessionStore(maxEntries: 2, ttl: 60, now: { clock })
    let first = store.insert(PDFDocument())
    let second = store.insert(PDFDocument())
    _ = store.document(for: first)
    let third = store.insert(PDFDocument())

    XCTAssertNil(store.document(for: second))
    XCTAssertNotNil(store.document(for: first))
    XCTAssertNotNil(store.document(for: third))

    clock.addTimeInterval(61)
    XCTAssertNil(store.document(for: first))
    XCTAssertNil(store.document(for: third))
    store.remove(first)
    store.remove(first)
    store.removeAll()
  }

  func testSyntheticSelectableTextPagePreservesExactCellsWithoutRawPageWall() throws {
    let source = "LDL       118 mg/dL\nHDL       52 mg/dL" as NSString
    let page = SyntheticTextPage(
      text: source as String,
      mediaBox: CGRect(x: -100, y: 50, width: 600, height: 800),
      characterRects: syntheticCharacterRects(
        source: source, mediaBox: CGRect(x: -100, y: 50, width: 600, height: 800))
    )
    let document = PDFDocument()
    document.insert(page, at: 0)

    let result = try XCTUnwrap(alytePDFTextLayerPage(document: document, pageIndex: 0))
    XCTAssertEqual(result["contractVersion"] as? String, "alyte.pdf.text-layer.v3")
    XCTAssertEqual(result["pageIndex"] as? Int, 0)
    XCTAssertEqual(result["orientation"] as? Int, 0)
    XCTAssertNil(result["sourceText"], "the adapter must not return an unbounded raw page wall")

    let observations = try XCTUnwrap(result["observations"] as? [[String: Any]])
    XCTAssertEqual(observations.count, 2)
    var previousEnd = 0
    var ids = Set<String>()
    for observation in observations {
      let id = try XCTUnwrap(observation["id"] as? String)
      XCTAssertTrue(ids.insert(id).inserted)
      let start = try XCTUnwrap(observation["sourceStart"] as? Int)
      let end = try XCTUnwrap(observation["sourceEnd"] as? Int)
      XCTAssertGreaterThanOrEqual(start, previousEnd)
      XCTAssertLessThan(start, end)
      XCTAssertEqual(
        observation["text"] as? String,
        source.substring(with: NSRange(location: start, length: end - start)))
      previousEnd = end

      let spans = try XCTUnwrap(observation["spans"] as? [[String: Any]])
      var previousSpanEnd = 0
      for span in spans {
        let spanStart = try XCTUnwrap(span["start"] as? Int)
        let spanEnd = try XCTUnwrap(span["end"] as? Int)
        let text = try XCTUnwrap(observation["text"] as? String)
        XCTAssertGreaterThanOrEqual(spanStart, previousSpanEnd)
        XCTAssertLessThan(spanStart, spanEnd)
        XCTAssertEqual(
          span["text"] as? String,
          (text as NSString).substring(
            with: NSRange(location: spanStart, length: spanEnd - spanStart)))
        XCTAssertEqual(span["parentObservationId"] as? String, id)
        let box = try XCTUnwrap(span["boundingBox"] as? [String: Double])
        XCTAssertGreaterThanOrEqual(box["x"] ?? -1, 0)
        XCTAssertGreaterThanOrEqual(box["y"] ?? -1, 0)
        XCTAssertGreaterThan(box["width"] ?? 0, 0)
        XCTAssertGreaterThan(box["height"] ?? 0, 0)
        XCTAssertLessThanOrEqual((box["x"] ?? 1) + (box["width"] ?? 1), 1)
        XCTAssertLessThanOrEqual((box["y"] ?? 1) + (box["height"] ?? 1), 1)
        previousSpanEnd = spanEnd
      }
    }
    let firstIDs = observations.compactMap { $0["id"] as? String }
    let secondIDs =
      try XCTUnwrap(alytePDFTextLayerPage(document: document, pageIndex: 0))["observations"]
      as? [[String: Any]]
    XCTAssertEqual(firstIDs, secondIDs.compactMap { $0["id"] as? String })
  }

  func testUnboundedVisibleCharacterBetweenCellsMakesTheWholePageUnavailable() {
    let source = "LDL X       118 mg/dL" as NSString
    var rects = syntheticCharacterRects(
      source: source, mediaBox: CGRect(x: 0, y: 0, width: 600, height: 800))
    let xOffset = (0..<source.length).first {
      source.substring(with: NSRange(location: $0, length: 1)) == "X"
    }
    rects[xOffset ?? 0] = .zero
    let page = SyntheticTextPage(
      text: source as String, mediaBox: CGRect(x: 0, y: 0, width: 600, height: 800),
      characterRects: rects)
    let document = PDFDocument()
    document.insert(page, at: 0)

    XCTAssertNil(alytePDFTextLayerPage(document: document, pageIndex: 0))
  }

  func testReorderedGlyphGeometryMakesTheWholePageUnavailable() {
    let source = "LDL 118 mg/dL" as NSString
    var rects = syntheticCharacterRects(
      source: source, mediaBox: CGRect(x: 0, y: 0, width: 600, height: 800))
    let visibleIndices = (0..<source.length).filter {
      !source.substring(with: NSRange(location: $0, length: 1)).trimmingCharacters(
        in: .whitespacesAndNewlines
      ).isEmpty
    }
    for (position, index) in visibleIndices.enumerated() {
      rects[index].origin.x = CGFloat(visibleIndices.count - position) * 0.01
    }
    let page = SyntheticTextPage(
      text: source as String, mediaBox: CGRect(x: 0, y: 0, width: 600, height: 800),
      characterRects: rects)
    let document = PDFDocument()
    document.insert(page, at: 0)

    XCTAssertNil(alytePDFTextLayerPage(document: document, pageIndex: 0))
  }

  func testMediaBoxOriginAndRightAngleRotationsMapToTopLeftBoxes() throws {
    let mediaBox = CGRect(x: -50, y: 25, width: 200, height: 100)
    let sourceRect = CGRect(x: mediaBox.minX + 10, y: mediaBox.minY + 60, width: 20, height: 5)
    let expected: [Int: CGRect] = [
      0: CGRect(x: 0.05, y: 0.35, width: 0.1, height: 0.05),
      90: CGRect(x: 0.6, y: 0.05, width: 0.05, height: 0.1),
      180: CGRect(x: 0.85, y: 0.6, width: 0.1, height: 0.05),
      270: CGRect(x: 0.35, y: 0.85, width: 0.05, height: 0.1),
    ]
    for rotation in [0, 90, 180, 270] {
      let transformed = try XCTUnwrap(
        alytePDFDisplayRect(sourceRect, pageBounds: mediaBox, rotation: rotation))
      let expectedBox = try XCTUnwrap(expected[rotation])
      XCTAssertEqual(transformed.minX, expectedBox.minX, accuracy: 0.000_001)
      XCTAssertEqual(transformed.minY, expectedBox.minY, accuracy: 0.000_001)
      XCTAssertEqual(transformed.width, expectedBox.width, accuracy: 0.000_001)
      XCTAssertEqual(transformed.height, expectedBox.height, accuracy: 0.000_001)
    }
  }

  func testExactSelectionGeometryOverridesValidButMisplacedCharacterBounds() throws {
    let source = "A" as NSString
    let mediaBox = CGRect(x: 0, y: 0, width: 100, height: 100)
    let page = SyntheticTextPage(
      text: source as String,
      mediaBox: mediaBox,
      characterRects: [CGRect(x: 10, y: 50, width: 10, height: 10)]
    )
    var requestedRanges: [NSRange] = []

    let glyphs = try XCTUnwrap(
      alytePDFTextGlyphs(
        page: page,
        source: source,
        pageBounds: mediaBox,
        rotation: 0,
        selectionBounds: { range in
          requestedRanges.append(range)
          return CGRect(x: 70, y: 50, width: 10, height: 10)
        }
      )
    )

    XCTAssertEqual(requestedRanges, [NSRange(location: 0, length: 1)])
    XCTAssertEqual(glyphs.count, 1)
    XCTAssertEqual(glyphs[0].bounds?.minX ?? -1, 0.7, accuracy: 0.000_001)
    XCTAssertEqual(glyphs[0].bounds?.minY ?? -1, 0.4, accuracy: 0.000_001)
  }

  func testComposedCharactersRemainWholeUTF16Ranges() throws {
    let source = "LDL 😀 118 mg/dL" as NSString
    let mediaBox = CGRect(x: 0, y: 0, width: 600, height: 800)
    let page = SyntheticTextPage(
      text: source as String,
      mediaBox: mediaBox,
      characterRects: syntheticCharacterRects(source: source, mediaBox: mediaBox)
    )
    let document = PDFDocument()
    document.insert(page, at: 0)
    let result = try XCTUnwrap(alytePDFTextLayerPage(document: document, pageIndex: 0))
    let observations = try XCTUnwrap(result["observations"] as? [[String: Any]])
    let emojiObservation = try XCTUnwrap(
      observations.first {
        (($0["spans"] as? [[String: Any]]) ?? []).contains {
          ($0["text"] as? String)?.contains("😀") == true
        }
      })
    let emojiSpan = try XCTUnwrap(
      (emojiObservation["spans"] as? [[String: Any]])?.first {
        ($0["text"] as? String)?.contains("😀") == true
      })
    let parentText = try XCTUnwrap(emojiObservation["text"] as? String)
    let emojiText = try XCTUnwrap(emojiSpan["text"] as? String)
    XCTAssertTrue(emojiText.contains("😀"))
    let start = try XCTUnwrap(emojiSpan["start"] as? Int)
    let end = try XCTUnwrap(emojiSpan["end"] as? Int)
    XCTAssertEqual(
      (parentText as NSString).substring(with: NSRange(location: start, length: end - start)),
      emojiText)
    XCTAssertNotNil(String.Index(utf16Offset: start, in: parentText).samePosition(in: parentText))
    XCTAssertNotNil(String.Index(utf16Offset: end, in: parentText).samePosition(in: parentText))
  }

  func testExactSelectionLineRangesRequireComposedCoverageAndRejectMalformedRanges() {
    let source = "ABC DEF\nGHI JKL" as NSString
    let valid = [
      NSRange(location: 0, length: 7),
      NSRange(location: 8, length: 7),
    ]
    XCTAssertEqual(alytePDFValidatedTextLineRanges(source: source, lineRanges: valid), valid)
    XCTAssertNil(
      alytePDFValidatedTextLineRanges(
        source: source,
        lineRanges: [NSRange(location: 0, length: 7), NSRange(location: 6, length: 9)]
      )
    )
    XCTAssertNil(
      alytePDFValidatedTextLineRanges(source: source, lineRanges: [NSRange(location: 0, length: 7)])
    )
    XCTAssertNil(
      alytePDFValidatedTextLineRanges(
        source: source,
        lineRanges: [NSRange(location: NSNotFound, length: 1)]
      )
    )
    XCTAssertNil(
      alytePDFValidatedTextLineRanges(
        source: source,
        lineRanges: [NSRange(location: Int.max - 1, length: 3)]
      )
    )

    let composed = "ABC 😀 DEF" as NSString
    XCTAssertNil(
      alytePDFValidatedTextLineRanges(
        source: composed, lineRanges: [NSRange(location: 0, length: 5)])
    )
  }

  func testSelectionGeometryRecoversOnlyTheAllowedUnboundedVisibleGlyphs() throws {
    let source = "ABCDEFGHIJ" as NSString
    let mediaBox = CGRect(x: -10, y: 20, width: 600, height: 800)
    let missing: Set<Int> = [2, 3]
    let glyphs = (0..<source.length).map { offset in
      let range = NSRange(location: offset, length: 1)
      let bounds =
        missing.contains(offset)
        ? nil
        : CGRect(
          x: mediaBox.minX + 30 + CGFloat(offset) * 15, y: mediaBox.minY + 600, width: 10,
          height: 20)
      return AlytePDFTextGlyph(
        range: range,
        text: source.substring(with: range),
        bounds: bounds,
        visible: true
      )
    }
    let recovered = try XCTUnwrap(
      alytePDFRecoverUnboundedGlyphs(
        glyphs,
        pageBounds: mediaBox,
        rotation: 0,
        selectionBounds: { range in
          CGRect(
            x: mediaBox.minX + 30 + CGFloat(range.location) * 15,
            y: mediaBox.minY + 600,
            width: 10,
            height: 20
          )
        }
      )
    )
    XCTAssertTrue(recovered.allSatisfy { $0.bounds != nil })

    let tooManyMissing = glyphs.enumerated().map { offset, glyph in
      offset == 4
        ? AlytePDFTextGlyph(
          range: glyph.range, text: glyph.text, bounds: nil, visible: glyph.visible)
        : glyph
    }
    XCTAssertNil(
      alytePDFRecoverUnboundedGlyphs(
        tooManyMissing,
        pageBounds: mediaBox,
        rotation: 0,
        selectionBounds: { _ in mediaBox.insetBy(dx: 30, dy: 100) }
      )
    )
  }

  func testExactSourceOrderSplitsCellsAtVisualXResetAndStableIDsUseOffsets() throws {
    let source = "ABCDEFGH" as NSString
    let glyphs = (0..<source.length).map { offset in
      let range = NSRange(location: offset, length: 1)
      let x = offset < 4 ? 0.1 + CGFloat(offset) * 0.03 : 0.1 + CGFloat(offset - 4) * 0.03
      return AlytePDFTextGlyph(
        range: range,
        text: source.substring(with: range),
        bounds: CGRect(x: x, y: 0.4, width: 0.02, height: 0.03),
        visible: true
      )
    }
    let line = AlytePDFTextLine(
      glyphs: glyphs,
      bounds: CGRect(x: 0.1, y: 0.4, width: 0.11, height: 0.03),
      sourceRange: NSRange(location: 0, length: source.length)
    )
    let cells = try XCTUnwrap(alytePDFCells(line: line, medianHeight: 0.03))
    XCTAssertEqual(
      cells.map(\.range), [NSRange(location: 0, length: 4), NSRange(location: 4, length: 4)])

    let gappedGlyphs = glyphs.enumerated().map { offset, glyph in
      let x =
        offset < 4
        ? 0.1 + CGFloat(offset) * 0.03
        : 0.5 + CGFloat(offset - 4) * 0.03
      return AlytePDFTextGlyph(
        range: glyph.range,
        text: glyph.text,
        bounds: CGRect(x: x, y: 0.4, width: 0.02, height: 0.03),
        visible: true
      )
    }
    let gappedLine = AlytePDFTextLine(
      glyphs: gappedGlyphs,
      bounds: CGRect(x: 0.1, y: 0.4, width: 0.52, height: 0.03),
      sourceRange: NSRange(location: 0, length: source.length)
    )
    let gappedCells = try XCTUnwrap(
      alytePDFCells(line: gappedLine, medianHeight: 0.03, splitXResets: false))
    XCTAssertEqual(
      gappedCells.map(\.range),
      [NSRange(location: 0, length: 4), NSRange(location: 4, length: 4)])

    let reorderedGlyphs = glyphs.enumerated().map { offset, glyph in
      let x: CGFloat
      switch offset {
      case 0: x = 0.1
      case 1: x = 0.5
      case 2: x = 0.1
      default: x = 0.5 + CGFloat(offset - 3) * 0.03
      }
      return AlytePDFTextGlyph(
        range: glyph.range,
        text: glyph.text,
        bounds: CGRect(x: x, y: 0.4, width: 0.02, height: 0.03),
        visible: true
      )
    }
    let reorderedLine = AlytePDFTextLine(
      glyphs: reorderedGlyphs,
      bounds: CGRect(x: 0.1, y: 0.4, width: 0.42, height: 0.03),
      sourceRange: NSRange(location: 0, length: source.length)
    )
    let reorderedCells = try XCTUnwrap(
      alytePDFCells(line: reorderedLine, medianHeight: 0.03, splitXResets: false))
    XCTAssertEqual(
      reorderedCells.map(\.range),
      [
        NSRange(location: 0, length: 1), NSRange(location: 1, length: 2),
        NSRange(location: 3, length: 5),
      ])

    let first = try XCTUnwrap(
      alytePDFTextLayerObservation(
        source: source,
        line: line,
        cells: cells,
        pageIndex: 3
      )
    )
    let second = try XCTUnwrap(
      alytePDFTextLayerObservation(
        source: source,
        line: line,
        cells: cells,
        pageIndex: 3
      )
    )
    XCTAssertEqual(first["id"] as? String, "pdf-3-line-0-8")
    XCTAssertEqual(first["id"] as? String, second["id"] as? String)
    XCTAssertEqual(
      (first["spans"] as? [[String: Any]])?.compactMap { $0["id"] as? String },
      ["pdf-3-span-0-4", "pdf-3-span-4-8"]
    )
  }

  func testDenseMixedTextCellUsesBoundedSecondPassWithoutChangingSourceRanges() throws {
    let source = "Marker 4.2" as NSString
    let glyphs = (0..<source.length).map { offset in
      let range = NSRange(location: offset, length: 1)
      let text = source.substring(with: range)
      if text == " " {
        return AlytePDFTextGlyph(range: range, text: text, bounds: nil, visible: false)
      }
      let wordBox =
        offset < 6
        ? CGRect(x: 0.1, y: 0.4, width: 0.05, height: 0.03)
        : CGRect(x: 0.153, y: 0.4, width: 0.025, height: 0.03)
      return AlytePDFTextGlyph(
        range: range,
        text: text,
        bounds: wordBox,
        visible: true
      )
    }
    let line = AlytePDFTextLine(
      glyphs: glyphs,
      bounds: CGRect(x: 0.1, y: 0.4, width: 0.078, height: 0.03),
      sourceRange: NSRange(location: 0, length: source.length)
    )

    let cells = try XCTUnwrap(alytePDFCells(line: line, medianHeight: 0.03))

    XCTAssertEqual(
      cells.map(\.range),
      [NSRange(location: 0, length: 6), NSRange(location: 7, length: 3)]
    )
    XCTAssertEqual(source.substring(with: cells[0].range), "Marker")
    XCTAssertEqual(source.substring(with: cells[1].range), "4.2")
  }

  func testDenseMixedTextSecondPassLeavesBroadNumericProseIntact() throws {
    let source = "Marker 1 2 3 4" as NSString
    let glyphs = (0..<source.length).map { offset in
      let range = NSRange(location: offset, length: 1)
      let text = source.substring(with: range)
      if text == " " {
        return AlytePDFTextGlyph(range: range, text: text, bounds: nil, visible: false)
      }
      let wordBox: CGRect
      if offset < 6 {
        wordBox = CGRect(x: 0.1, y: 0.4, width: 0.05, height: 0.03)
      } else {
        let numericIndex = (offset - 7) / 2
        wordBox = CGRect(
          x: 0.153 + CGFloat(numericIndex) * 0.023,
          y: 0.4,
          width: 0.02,
          height: 0.03
        )
      }
      return AlytePDFTextGlyph(
        range: range,
        text: text,
        bounds: wordBox,
        visible: true
      )
    }
    let line = AlytePDFTextLine(
      glyphs: glyphs,
      bounds: CGRect(x: 0.1, y: 0.4, width: 0.142, height: 0.03),
      sourceRange: NSRange(location: 0, length: source.length)
    )

    let cells = try XCTUnwrap(alytePDFCells(line: line, medianHeight: 0.03))

    XCTAssertEqual(cells.map(\.range), [NSRange(location: 0, length: source.length)])
  }

  func testLessThanEightyPercentBoundedVisibleGlyphsMakesPageUnavailable() {
    let source = "ABCDEFGHIJ" as NSString
    let mediaBox = CGRect(x: 0, y: 0, width: 600, height: 800)
    var rects = syntheticCharacterRects(source: source, mediaBox: mediaBox)
    rects[2] = .zero
    rects[3] = .zero
    rects[4] = .zero
    let page = SyntheticTextPage(text: source as String, mediaBox: mediaBox, characterRects: rects)
    let document = PDFDocument()
    document.insert(page, at: 0)

    XCTAssertNil(alytePDFTextLayerPage(document: document, pageIndex: 0))
  }

  func testImageOnlyAndOverCapPagesAreUnavailableWithoutTruncation() {
    let image = UIGraphicsImageRenderer(size: CGSize(width: 600, height: 800)).image { context in
      UIColor.white.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 600, height: 800))
    }
    let imageDocument = PDFDocument()
    imageDocument.insert(PDFPage(image: image)!, at: 0)
    XCTAssertNil(alytePDFTextLayerPage(document: imageDocument, pageIndex: 0))

    let overCapText = String(repeating: "A", count: alytePDFTextLayerMaximumCharacters + 1)
    let overCapSource = overCapText as NSString
    let overCapPage = SyntheticTextPage(
      text: overCapText,
      mediaBox: CGRect(x: 0, y: 0, width: 600, height: 800),
      characterRects: syntheticCharacterRects(
        source: overCapSource, mediaBox: CGRect(x: 0, y: 0, width: 600, height: 800))
    )
    let overCapDocument = PDFDocument()
    overCapDocument.insert(overCapPage, at: 0)
    XCTAssertNil(alytePDFTextLayerPage(document: overCapDocument, pageIndex: 0))
  }

  func testPathReaderHardFailsWrongPasswordAndSessionReaderUsesUnlockedDocument() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("alyte-pdf-text-layer-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let plainURL = directory.appendingPathComponent("plain.pdf")
    UIGraphicsBeginPDFContextToFile(plainURL.path, CGRect(x: 0, y: 0, width: 600, height: 800), nil)
    UIGraphicsBeginPDFPage()
    let attributes: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: 18),
      .foregroundColor: UIColor.black,
    ]
    NSString(string: "LDL 118 mg/dL").draw(at: CGPoint(x: 40, y: 80), withAttributes: attributes)
    NSString(string: "HDL 52 mg/dL").draw(at: CGPoint(x: 40, y: 120), withAttributes: attributes)
    UIGraphicsEndPDFContext()
    let source = try XCTUnwrap(PDFDocument(url: plainURL))
    let url = directory.appendingPathComponent("password.pdf")
    XCTAssertTrue(
      source.write(
        to: url,
        withOptions: [
          .ownerPasswordOption: "synthetic-owner",
          .userPasswordOption: "synthetic-user",
        ]))

    XCTAssertThrowsError(try alytePDFTextLayerPage(path: url.path, pageIndex: 0, password: "wrong"))
    let unlocked = try XCTUnwrap(PDFDocument(url: url))
    XCTAssertTrue(unlocked.unlock(withPassword: "synthetic-user"))
    let sessionID = AlytePDFSessionStore.shared.insert(unlocked)
    defer { AlytePDFSessionStore.shared.remove(sessionID) }
    XCTAssertNotNil(try alytePDFTextLayerPage(sessionId: sessionID, pageIndex: 0))
    AlytePDFSessionStore.shared.remove(sessionID)
    XCTAssertThrowsError(try alytePDFTextLayerPage(sessionId: sessionID, pageIndex: 0))
  }

}

private final class SyntheticTextPage: PDFPage {
  private let syntheticText: String
  private let syntheticMediaBox: CGRect
  private let syntheticCharacterBounds: [CGRect]

  init(text: String, mediaBox: CGRect, characterRects: [CGRect], rotation: Int = 0) {
    syntheticText = text
    syntheticMediaBox = mediaBox
    syntheticCharacterBounds = characterRects
    super.init()
    setBounds(mediaBox, for: .mediaBox)
    self.rotation = rotation
  }

  override var string: String? { syntheticText }

  override var numberOfCharacters: Int { (syntheticText as NSString).length }

  override func bounds(for box: PDFDisplayBox) -> CGRect { syntheticMediaBox }

  override func characterBounds(at index: Int) -> CGRect {
    guard index >= 0, index < syntheticCharacterBounds.count else { return .zero }
    return syntheticCharacterBounds[index]
  }
}

private func syntheticCharacterRects(source: NSString, mediaBox: CGRect) -> [CGRect] {
  var rects: [CGRect] = []
  rects.reserveCapacity(source.length)
  var x = mediaBox.minX + 40
  var y = mediaBox.minY + mediaBox.height - 80
  for offset in 0..<source.length {
    let range = NSRange(location: offset, length: 1)
    let character = source.substring(with: range)
    if character == "\n" {
      rects.append(.zero)
      x = mediaBox.minX + 40
      y -= 48
      continue
    }
    if character.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      rects.append(.zero)
      x += 10
      continue
    }
    let width: CGFloat = 18
    rects.append(CGRect(x: x, y: y, width: width, height: 24))
    x += width + 2
  }
  return rects
}
