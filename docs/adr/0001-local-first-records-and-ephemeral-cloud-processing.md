# Keep health records local and make cloud processing ephemeral

Alyte keeps imported reports, measurements, intake history, and returned processing results
on the user's device as the source of truth. Cloud services receive only the minimum data required
for an explicitly requested operation and do not retain health payloads by default. This preserves
an account-free private core and limits breach exposure, at the cost of no server-backed history or
live cross-device synchronization in the first release.

Cloud work is asynchronous. The backend returns an opaque request ID, deletes submitted media once
processing no longer needs it, and keeps a usable result encrypted for the requesting device in a
retrieval cache for at most 24 hours. A Cloud Analysis is charged when that result is produced, not
when the device fetches it. Retrieval deletes the cached result early; otherwise terminal expiry
does. This permits fire-and-forget use without turning the backend into the health-record source of
truth.

Cloud vision may structure a Snap and propose catalogue-backed relationships, but longitudinal
matching between Intake Events and Lab Records happens on-device. Alyte does not periodically
upload the person's full health history merely to produce Related Wellness Context.

A cloud account is an optional capability boundary, not the identity of the local dataset. Signing
out or deleting that account removes app-controlled server data without deleting local records or
preventing continued local use. Users can export both their complete local dataset and whatever
account data the service controls.

Current App Review rules prohibit storing personal health information in iCloud. Alyte
therefore excludes its health records, reports, intake media, and device-bound encryption material
from iCloud storage and iCloud Backup in the first release. User-controlled Full Export provides
portability; live multi-device sync and app-managed restore are deferred pending both a replication
design and explicit compliance confirmation.
