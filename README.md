# Alyte

A personal experiment in on-device AI and local-first lab report tracking.

I started Alyte out of curiosity: how useful are AI models running locally on mobile devices,
and could they help turn lab reports into a readable history of measured biomarkers?

The idea was simple: import reports, review and correct extracted measurements, compare compatible
results over time, and keep control of the data through export and deletion. Local processing and
preserving the original source were central to the experiment.

**Development has stopped.** This repository preserves the work and experiments as they stood.
It is an unfinished prototype, not a released or clinically validated product. Extraction needs
human review; Alyte does not diagnose, prescribe, or explain what caused a result to change.

## In the repo

- [`apps/mobile`](apps/mobile) — the iOS app, built with Expo, React Native, and TypeScript.
- [`apps/mobile/modules`](apps/mobile/modules) — Swift modules for PDFKit, Vision, protected
  storage, and local model execution through llama.cpp.
- [`apps/import-desktop`](apps/import-desktop/README.md) — a Mac tester for the report-import pipeline.
- [`packages`](packages) — shared domain logic, contracts, evidence catalogue, and synthetic fixtures.
- [`scripts/import-evaluation`](scripts/import-evaluation/README.md) — extraction experiments and evaluation tools.
- [`apps/api`](apps/api/README.md) — exploratory backend work for optional cloud features.

## Development

Use Node.js 24 and npm 11:

```sh
npm ci
npm run build
npm run dev
```

The mobile app uses custom native modules and requires an iOS development build; Expo Go is
insufficient. Native development requires macOS and Xcode. For the standalone Mac import tester,
see its [setup instructions](apps/import-desktop/README.md).

The [product notes](docs/MVP.md) and [architecture](docs/ARCHITECTURE.md) document the original
intent and technical decisions. Planned features and release dates there are historical.

No reuse license is granted for the project's own code. Third-party components retain their
respective licenses.
