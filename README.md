# OrcaAi Server

Fastify API server for OrcaAi, written in TypeScript and running on Node.js 22+.

The server keeps AI providers, data/tool providers, AI SDK tools and fishing
skills separate. External data is fetched only through registered tool
providers; the agent never receives unrestricted web access or provider keys.

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

The server listens on `http://127.0.0.1:3001` by default.

## Routes

- `GET /` — basic service response
- `GET /health` — health check for local and deployment probes
- `POST /v1/chat` — streaming agent chat
- `POST /v1/assess` — deterministic fishing assessment
- `GET /v1/source-status` — configured provider/model status
- `WS /v1/voice/stt` — Sarvam realtime STT proxy
- `WS /v1/voice/tts` — Sarvam Bulbul v3 TTS proxy

## Verification

```bash
npm run typecheck
npm run build
npm start
curl http://127.0.0.1:4000/health
```

Set `HOST=0.0.0.0` when the server needs to accept connections from a container or another machine.

## Environment

Provider API keys belong in the server `.env` only. The active chat provider is
Google AI Studio, configured with `GOOGLE_GENERATIVE_AI_API_KEY`,
`GOOGLE_PRIMARY_MODEL` and `GOOGLE_FALLBACK_MODEL`. The browser must never
receive `GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `SARVAM_API_KEY`,
`SCOUTIFY_API_KEY` or government API credentials. Missing provider credentials
are reported as unavailable data. A structured Open-Meteo forecast can still
support a conservative `CAUTION` result when all official alert feeds are
temporarily unavailable; it must never produce `GO` without the approved
safety policy, and Scoutify research cannot override the deterministic
assessment.
