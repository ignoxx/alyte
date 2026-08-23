# Issue 33 verification

All interaction evidence uses the de-identified `alyte-issue-31-synthetic.pdf` fixture.

## Native interaction

- iPhone 15 Pro simulator, iOS 26.5, Debug custom development client.
- Opened Labs > synthetic report > Review Sanitized Report.
- Confirmed the compact editing toolbar, separate `Sanitize Report` action, current-page count,
  selection-aware Remove action, and calm Undo/Redo disabled states.
- Exercised the native redaction's VoiceOver move action. The overlay remained selected and Undo
  became enabled, confirming a single authoritative edit was committed.
- Attempted a full virtual-pointer drag and recorded it in `redaction-gesture.mp4`. The simulator's
  macOS pointer bridge did not deliver that drag as a touch gesture, so the multi-change behavior is
  verified by the native geometry/session harness instead of claiming device-level pointer proof.
- Captured light mode and dark mode with Extra Large Dynamic Type. The document remains dominant,
  labels remain legible, and the action area clears the home indicator.

## Focused checks

- Swift geometry/session harness: passed. It covers multiple changed events accumulated from one
  immutable gesture start, controlled-prop updates during the active gesture, cancellation,
  move/resize bounds, and the 24-point minimum resize target.
- Mobile ESLint and TypeScript: passed.
- Clean `xcodebuild` against the iOS 26.5 simulator SDK: passed.
- Full `npm run ci`: passed.

## Design references

The action hierarchy follows patterns shared by Apple Preview and Markup, Files Quick Look, Notes
PDF annotation, Adobe Acrobat Redact/Organize, PDF Expert reader/Redact, Foxit, Smallpdf, and the
pinned T3 Code mobile app: keep the canvas dominant, group contextual edit actions compactly, make
disabled history actions quiet, and visually separate the irreversible/primary completion action.
No reference pixels or proprietary assets were copied.
