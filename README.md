# Alyte

Alyte is a local-first laboratory-history and intake-awareness app. The first workspace commit
keeps the shell account-free and offline-capable while later slices add local records and optional
cloud processing.

## Development

Use Node.js 24 LTS and npm 11:

```sh
npm ci
npm run build
npm run dev
```

`npm run dev` starts the Expo development client, the local Fastify API/job-runner entrypoint, and
watchers for every shared package. Docker is not required. The only hosted API environment is
production; development and preview app variants do not point at a persistent backend.

The iOS variants are selected with `APP_VARIANT=development|preview|production` and are also
available as EAS build profiles. Production builds cannot enable synthetic showcase mode.
