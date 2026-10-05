# Local import tester for macOS

A standalone Electron window for exercising Alyte's existing phone extraction pipeline. It reuses
`report-service.ts`, the production PDFKit text-layer reader, Vision observations, header/table
parsing, PaddleOCR parsing and grounding, and catalogue mapping through the existing Mac adapter.
There is no Rust rewrite and no separate desktop extraction algorithm.

## Run

On a Mac with Xcode command-line tools, the repository's Node/npm versions, and dependencies installed:

```sh
npm run setup:models --workspace=@alyte/import-desktop
npm run dev:import
```

The first command downloads approximately 1.38 GB of pinned PaddleOCR weights and verifies their
SHA-256 hashes against the phone manifest. Model files live in `~/.cache/alyte-import-models`.
Install a PaddleOCR-compatible `llama-mtmd-cli` separately; the default path is
`/opt/homebrew/bin/llama-mtmd-cli`. `ALYTE_PADDLE_RUNTIME`, `ALYTE_PADDLE_MODEL`, and
`ALYTE_PADDLE_PROJECTOR` override paths. Model overrides must match the pinned checksums.
Without the runtime or model files, the UI explicitly labels the PDFKit/Vision-only mode.

Choose a PDF to run extraction, inspect the original next to extracted proposals and review
reasons, rerun, export JSON, or clear the imported copy and derived files. This is a developer
application run from the checkout, not a signed/distributable `.app` bundle.

## Scope and privacy

- PDF files up to 25 MB. Password-protected PDFs and image-file selection are not supported yet.
- All report processing is local. A loopback-only server connects the sandboxed desktop window
  to an isolated Node worker and native/model subprocesses. No report content is logged.
- The app uses a temporary Electron profile and an in-memory browser session. Requests outside
  the local app and Chromium's internal PDF viewer are blocked.
- Imported copies, SQLite databases, native observations, and crops are in a private temporary
  session directory under `~/Library/Caches/AlyteImportLab/sessions`. Clear/delete, replacement import, and normal shutdown remove them. A force-kill or
  system crash can leave temporary files; this tester does not claim production cleanup guarantees.
- Exported JSON is a user-owned copy and is not removed by Clear & delete. Downloaded model weights
  are retained independently of report data.
- Results are extraction proposals. The tester does not correct/confirm records or create a health
  history. Canonical IDs and review reasons are intentionally visible for pipeline inspection.
- The shared algorithm is exercised on Mac; Mac results do not establish phone performance.
  Desktop model execution uses the local llama.cpp CLI, while the phone uses its native runtime.
- The Mac adapter's JSON export is an evaluation projection, not Alyte's Full Export format.

## Verify

```sh
npm run typecheck --workspace=@alyte/import-desktop
npm run test --workspace=@alyte/import-desktop
```

Use synthetic PDFs only for automated tests and screenshots. A native integrated smoke check should
cover a selectable PDF, an image-only PDF, original preview, JSON export, retry, and deletion.
