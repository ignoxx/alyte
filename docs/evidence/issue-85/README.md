# Issue 85 — increased-memory entitlement

`apps/mobile/app.config.js` declares Apple's supported
`com.apple.developer.kernel.increased-memory-limit` entitlement for every iOS variant. The
existing `ios.entitlements` object is merged first, so upstream/config entitlements remain intact.
The configuration intentionally does not declare Extended Virtual Addressing or Increased
Debugging Memory Limit.

This is a supported-device best-effort capability. It does not change model packaging, runtime
behavior, user-facing copy, report data, or retry/download semantics. Because entitlements are
native configuration, this change changes the Expo native fingerprint and requires a newly built
and signed binary. Device eligibility, Apple provisioning, and whether the additional memory is
granted remain release/device validation requirements; an entitlement alone does not guarantee
activation succeeds.
