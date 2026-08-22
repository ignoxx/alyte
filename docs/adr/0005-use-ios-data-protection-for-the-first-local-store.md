# Use iOS Data Protection for the first local store

The first release protects its SQLite database and health-content files with iOS Data Protection,
app-container isolation, explicit iCloud Backup exclusion, optional biometric app lock, and
Keychain/CryptoKit protection for secrets and device keys. SQLCipher is not a launch dependency.

This choice keeps the account-free local product protected by the device passcode while avoiding a
new database engine, native build flags, migration recovery path, and performance risk during a
short release schedule. Alyte explicitly applies and verifies protection attributes for the
database, WAL/SHM siblings, Original Reports, Sanitized Reports, Intake Images, and transient/export
files rather than relying on undocumented defaults.

The trade-off is that this is file-level platform encryption rather than a second application-level
database cryptosystem. The privacy documentation must describe the protection accurately. The
threat model does not claim to defend an unlocked, compromised device or a process already able to
read the app container.

A focused post-launch security review may add SQLCipher if its additional protection justifies the
dependency, migration, backup, performance, and Expo-upgrade costs. Adding it requires a separate
ADR and a tested in-place migration that never strands existing local records.
