# Build the iOS client with Expo and narrow native modules

Alyte will use React Native, Expo, and strict TypeScript for the first iOS client, with iOS 26 as
the minimum deployment target for the MVP. React Navigation's native bottom tabs and native
stacks/sheets provide platform navigation and UIKit materials, including Liquid Glass where the
system supplies it. Custom Apple-framework behavior
will live in small tracked Expo modules and config plugins, while generated native projects remain
reproducible through Expo prebuild.

This follows the successful boundary visible in T3 Code's mobile app: most product UI and state can
move quickly in React Native, while native behavior remains available where platform correctness or
polish matters. It also preserves a realistic path to Android without forcing platform-neutral
abstractions into the first release.

The initial native modules cover Vision OCR, PDFKit inspection/rendering/sanitization, iOS file
protection and backup exclusion, and CryptoKit device-key operations. Ordinary screens, domain
logic, local repositories, charts, cloud orchestration, and purchase UI remain TypeScript unless a
measured platform limitation justifies moving them.

Alyte will not copy T3 Code's Effect graph, event-sourced orchestration, widgets, extensions,
or multi-surface architecture. Those mechanisms solve different product constraints. Complexity
belongs at Alyte's own adapter boundaries: documents, OCR, evidence, persistence, purchases,
and optional cloud processing.

Expo Go is insufficient because the product requires custom native code. Development uses an Expo
development client. EAS profiles provide separate development, preview, and production builds; any
over-the-air update channel uses native fingerprint compatibility.
