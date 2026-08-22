# Run the first cloud backend on Railway with SQLite

Alyte's first cloud backend will run as one Node.js service on Railway EU West with Fastify, a durable SQLite job queue, transient uploads, and encrypted result envelopes on one persistent volume. This deliberately accepts brief deployment downtime and a single-server ceiling in exchange for the smallest operable system; move to Postgres and separately scaled workers only when real load, availability needs, or multi-instance deployment justify that complexity.
