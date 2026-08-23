# Issue 35 native runtime evidence

`native-pdf-runtime.png` was captured from the rebuilt `com.alyte.app.dev` development client on
the iOS 26.5 `Alyte iPhone 15 Pro` simulator. The workspace displays only the retained
`alyte-synthetic-lab-report.pdf` fixture; its visible heading identifies it as a de-identified
synthetic laboratory report.

The simulator accessibility tree exposed the rendered PDF text, the existing synthetic redaction,
and the Redact, Undo, Redo, Remove, Pages, and Sanitize Report controls. This pass used virtual
macOS pointer clicks for navigation. It did not claim genuine injected iOS touch input.

The Preview and Development clients share the same development URL scheme on this simulator, so
the Development client was launched explicitly by bundle ID before selecting this branch's Metro
server. This avoids accidentally validating the separately installed Preview binary.

## Controlled A/B result

The candidate registration experiment and the original `ee4c1dd` registration shape were each
cleanly prebuilt, built, installed, and launched as the exact `com.alyte.app.dev` bundle against
this worktree's Metro server. Both rendered this PDFKit workspace. The proposed `ViewName`, public
view visibility, and two-argument JavaScript lookup were therefore not causal and were removed.

The reported redbox was reproduced only when the shared `exp+alyte` URL was handled by the stale
`com.alyte.app.preview` installation. Unified simulator logs identified that process as
`AlytePreview`, while the successful controlled run identified `AlyteDevelopment` and registered
the existing `AlytePDF` module. This was a simulator validation-target error, not an AlytePDF
product runtime defect, so no native registration or app-scheme change is included.
