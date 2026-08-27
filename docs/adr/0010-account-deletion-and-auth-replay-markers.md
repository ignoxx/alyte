---
status: accepted
---

# Preserve a short-lived unlinkable marker after cloud-account deletion

Alyte cloud-account deletion removes the account, sessions, entitlement and purchase state,
encrypted operation responses, and all user or health records controlled by the service. To keep a
captured Apple credential from immediately recreating an account, the service may retain one
unlinkable HMAC credential/nonce replay marker for at most 24 hours. The marker contains no account
identifier, raw nonce or token, response, health data, or exportable user content; cleanup removes
it at expiry.

This is a deliberate boundary between erasing the account and preventing replay of authentication
material that was already accepted. It is not a recoverable account record and cannot restore,
identify, or authenticate a deleted account.
