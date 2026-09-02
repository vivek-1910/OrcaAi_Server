import { pipeAgentUIStreamToResponse } from "ai";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { FisherContextSchema } from "../types/fishing.js";
import { createOrcaAgent } from "../ai/orca-agent.js";
import { selectAvailableGoogleModel } from "../ai/google-provider.js";

type ChatBody = {
  id?: unknown;
  messages?: unknown[];
  fisherContext?: unknown;
  trigger?: unknown;
  messageId?: unknown;
};

function streamCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "X-Orca-Model, X-Orca-Provider",
    Vary: "Origin",
  };
}

function messageSummary(messages: unknown[]): Array<{ role?: unknown; partTypes: string[] }> {
  return messages.slice(-3).map((message) => {
    if (!message || typeof message !== "object") return { partTypes: [] };
    const record = message as { role?: unknown; parts?: unknown[] };
    return {
      role: record.role,
      partTypes: Array.isArray(record.parts)
        ? record.parts.map((part) => part && typeof part === "object" && "type" in part ? String((part as { type?: unknown }).type) : "unknown")
        : [],
    };
  });
}

function badBody(body: ChatBody): Error | undefined {
  if (!Array.isArray(body.messages)) return new Error("messages must be an array.");
  if (body.messages.length > 80) return new Error("messages cannot contain more than 80 items.");
  return undefined;
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/v1/chat",
    async (request: FastifyRequest<{ Body: ChatBody }>, reply) => {
      const body = request.body ?? {};
      const bodyError = badBody(body);
      if (bodyError) return reply.code(400).send({ error: bodyError.message });
      request.log.info({
        chatId: body.id,
        trigger: body.trigger,
        messageId: body.messageId,
        messageCount: body.messages?.length ?? 0,
        messages: messageSummary(body.messages ?? []),
      }, "Orca chat request accepted");

      let context;
      try {
        context = FisherContextSchema.parse(body.fisherContext);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "fisherContext is invalid.",
        });
      }

      let selection;
      try {
        selection = await selectAvailableGoogleModel();
        request.log.info({ model: selection.modelId, fallbackModel: selection.fallbackModelId }, "Google AI Studio model selected");
      } catch (error) {
        request.log.warn({ error }, "Google AI Studio is not available for this chat request");
        return reply.code(503).send({
          error: {
            code: "AI_PROVIDER_UNAVAILABLE",
            message: "Orca's AI provider is not configured or available right now.",
          },
        });
      }

      let agent;
      try {
        agent = createOrcaAgent(context, selection.modelId, selection.fallbackModelId).agent;
      } catch (error) {
        request.log.error({ error }, "Could not create Orca agent");
        return reply.code(503).send({
          error: {
            code: "AI_AGENT_UNAVAILABLE",
            message: "Orca could not start the fishing agent.",
          },
        });
      }

      const abortController = new AbortController();
      request.raw.once("aborted", () => abortController.abort());
      reply.hijack();

      try {
        request.log.info("Orca agent stream starting");
        await pipeAgentUIStreamToResponse({
          response: reply.raw,
          agent,
          uiMessages: body.messages ?? [],
          abortSignal: abortController.signal,
          timeout: { totalMs: 90_000 },
          sendReasoning: false,
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Orca-Model": selection.modelId,
            "X-Orca-Provider": "google-ai-studio",
            ...streamCorsHeaders(request.headers.origin),
          },
          onError: (error) => {
            request.log.error({ error }, "Orca agent stream failed");
            return "Orca could not complete this fishing brief. Please try again.";
          },
        });
      } catch (error) {
        request.log.error({ error }, "Orca chat response failed");
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 503;
          reply.raw.setHeader("Content-Type", "application/json; charset=utf-8");
          reply.raw.end(JSON.stringify({ error: "Orca chat is temporarily unavailable." }));
        } else if (!reply.raw.destroyed) {
          reply.raw.destroy(error instanceof Error ? error : undefined);
        }
      }
    },
  );
}
