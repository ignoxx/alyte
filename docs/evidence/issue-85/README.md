# Issue 85 — increased-memory entitlement

> Superseded by issue #171. This README preserves the historical entitlement evidence and
> screenshots for traceability; it is not the current MVP policy.

Current MVP development, preview, and production variants no longer request either
`com.apple.developer.kernel.increased-memory-limit` or
`com.apple.developer.kernel.extended-virtual-addressing`. The retired local-model experiment is
not part of the mobile dependency or native target.

`apps/mobile/app.config.js` declares Apple's supported
`com.apple.developer.kernel.increased-memory-limit` entitlement for every iOS variant. Preview and
production add the related `com.apple.developer.kernel.extended-virtual-addressing` entitlement
through the same additive merge, so upstream/config entitlements remain intact. Development omits
Extended Virtual Addressing by default because Apple Personal Team profiles do not support that
capability. The configuration intentionally does not declare Increased Debugging Memory Limit.

The focused config check invokes the installed Expo CLI's `config --type introspect --json` pipeline
for the development, preview, and production variants and asserts the exact variant policy: only
preview and production emit Extended Virtual Addressing, while development emits only Increased
Memory Limit. It separately exercises the dynamic config with an upstream entitlement to verify
that the merge remains additive. A development build is therefore not evidence for the full
production memory entitlement set; that requires a distribution-capable signed build.

This is a supported-device best-effort capability. It does not change model packaging, runtime
behavior, user-facing copy, report data, or retry/download semantics. Because entitlements are
native configuration, this change changes the Expo native fingerprint and requires a newly built
and signed binary. Device eligibility, Apple provisioning, and whether the additional memory is
granted remain release/device validation requirements; an entitlement alone does not guarantee
activation succeeds.
