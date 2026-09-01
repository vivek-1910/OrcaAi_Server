import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";

const defaultCorsOrigin = "http://localhost:3000";

function getCorsOrigin(): string | string[] {
  const origins = (process.env.CORS_ORIGIN ?? defaultCorsOrigin)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length === 1 ? (origins[0] ?? defaultCorsOrigin) : origins;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(helmet);
  app.register(cors, { origin: getCorsOrigin() });

  app.get("/", async () => ({
    name: "orca-ai-server",
    status: "ok",
  }));

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            required: ["service", "status"],
            properties: {
              service: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      service: "orca-ai-server",
      status: "ok",
    }),
  );

  return app;
}
