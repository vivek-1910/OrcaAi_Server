# OrcaAi Server

Fastify API server for OrcaAi, written in TypeScript and running on Node.js.

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

The server listens on `http://127.0.0.1:4000` by default.

## Routes

- `GET /` — basic service response
- `GET /health` — health check for local and deployment probes

## Verification

```bash
npm run typecheck
npm run build
npm start
curl http://127.0.0.1:4000/health
```

Set `HOST=0.0.0.0` when the server needs to accept connections from a container or another machine.
