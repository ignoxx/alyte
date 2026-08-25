# Use a portable ZIP archive for Full Export

Alyte Full Export uses an ordinary `.zip` archive produced on-device by the pinned ZIPFoundation
0.9.20 library behind the narrow `AlyteProtection` Expo module. A dependency-free Apple Archive
(`.aar`) would provide strong native streaming and verification, but its limited interoperability
conflicts with Full Export's purpose: the user must be able to take their records to common desktop
and mobile tools outside Alyte and outside the Apple ecosystem.

ZIPFoundation is limited to the export adapter, receives only allowlisted app-owned staging paths,
and must use streaming file APIs, progress/cancellation, symlink containment, entry/count/checksum
verification, atomic promotion, iOS Data Protection, backup exclusion, and complete transient-file
cleanup. The exact version is pinned and its MIT license ships with required notices. This changes
the native fingerprint and requires a new binary; restore/import and accepting arbitrary ZIP input
remain outside the first release.
