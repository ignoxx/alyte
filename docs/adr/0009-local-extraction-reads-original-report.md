# Local extraction reads the protected Original Report

For the account-free laboratory journey, Vision OCR and the constrained on-device semantic mapper
read the verified protected Original Report directly, while every Extraction Draft and confirmed
Measurement retains explicit Original artifact provenance. Sanitization remains implemented as a
separate, independently verifiable derivative for a future explicit cloud upload; it is not a
prerequisite for local extraction, and changing or deleting that derivative must not invalidate
Original-derived local drafts.

## Consequences

- The service verifies the Original's protected path and immutable hash immediately before each
  Vision call and keeps PDF passwords ephemeral.
- Import can present one full-screen Import → OCR → On-device model → Review journey and preserve
  the report/draft through retry, suspension, process relaunch, and model failure. A report-keyed
  operation marker reconciles abandoned work to an explicit interrupted state.
- Draft provenance is an identity contract: Original means a null derivative ID plus the recorded
  Original hash, while Sanitized means a stable derivative ID plus hash. Pre-#75 drafts without
  that identity are explicitly invalidated as legacy Sanitized work and must be regenerated.
- Sanitized-derived drafts, when a future cloud flow creates them, are invalidated only when their
  exact derivative changes or is deleted.
