# Local extraction reads the protected Original Report

For the account-free laboratory journey, a strict PDFKit text-layer adapter and Vision OCR read the
verified protected Original Report directly. Each selectable PDF page uses PDFKit only when its
complete `alyte.pdf.text-layer.v3` result is trusted; an unavailable or untrusted page, an
image-only PDF page, and an image import use Vision only. The two native sources are never merged
for one page. Trusted selectable-PDF pages may use supported Result-header geometry to narrow a row
to one exact source-backed result; the rule fails open and is not applied to Vision pages without
equivalent scan evidence. Deterministic code owns source IDs and field projection; ambiguous rows
remain focused review work instead of depending on a model. Every Extraction Draft and confirmed
Measurement retains explicit Original artifact provenance. Sanitization remains
implemented as a separate, independently verifiable derivative for a future explicit cloud upload;
it is not a prerequisite for local extraction, and changing or deleting that derivative must not
invalidate Original-derived local drafts.

## Consequences

- The service verifies the Original's protected path and immutable hash immediately before and
  after each native PDFKit or Vision page read and keeps PDF passwords ephemeral. A missing
  Original, cancellation, wrong password, or hash mismatch is a hard actionable failure; an
  unavailable or untrusted PDF text layer is a normal Vision fallback.
- The PDFKit adapter preserves exact NSString/UTF-16 source slices, normalized page geometry,
  stable page/source-offset IDs, and bounded parent/span provenance. It rejects malformed,
  partial, reordered, overlapping, out-of-bounds, insufficient, or over-cap pages rather than
  emitting a partial source wall. A trusted page is atomic: no Vision observation is added to it.
- The PDF text-layer adapter version is included in the extraction pipeline fingerprint for PDF
  inputs. Missing legacy fields decode as absent without a database migration; changed adapter
  output is classified as older and can be regenerated honestly. Image inputs have no PDF adapter
  version.
- The adapter is native code, so its addition or change updates the native fingerprint and requires
  a new development/TestFlight binary. It introduces no dependency, entitlement, permission, or
  database migration.
- Import can present one full-screen Import → OCR → Review journey and preserve the report/draft
  through retry, suspension, and process relaunch. A report-keyed
  operation marker reconciles abandoned work to an explicit interrupted state.
- Draft provenance is an identity contract: Original means a null derivative ID plus the recorded
  Original hash, while Sanitized means a stable derivative ID plus hash. Pre-#75 drafts without
  that identity are explicitly invalidated as legacy Sanitized work and must be regenerated.
- Sanitized-derived drafts, when a future cloud flow creates them, are invalidated only when their
  exact derivative changes or is deleted.
