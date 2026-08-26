# Issue 85 — increased-memory entitlement

`apps/mobile/app.config.js` declares Apple's supported
`com.apple.developer.kernel.increased-memory-limit` entitlement for every iOS variant. Issue #89
adds the related `com.apple.developer.kernel.extended-virtual-addressing` entitlement through the
same additive merge, so upstream/config entitlements remain intact. The configuration intentionally
does not declare Increased Debugging Memory Limit.

The focused config check invokes the installed Expo CLI's `config --type introspect --json` pipeline
for the development, preview, and production variants and asserts the entitlement in each emitted
configuration. It separately exercises the dynamic config with an upstream entitlement to verify
that the merge remains additive.

This is a supported-device best-effort capability. It does not change model packaging, runtime
behavior, user-facing copy, report data, or retry/download semantics. Because entitlements are
native configuration, this change changes the Expo native fingerprint and requires a newly built
and signed binary. Device eligibility, Apple provisioning, and whether the additional memory is
granted remain release/device validation requirements; an entitlement alone does not guarantee
activation succeeds.
