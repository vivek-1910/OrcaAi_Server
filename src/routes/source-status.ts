import type { FastifyInstance } from "fastify";
import { groqHealth } from "../ai/groq-provider.js";
import { sarvamApiKeyPresent } from "../tool-providers/sarvam-client.js";

export async function registerSourceStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/source-status", async () => ({
    providers: {
      groq: await groqHealth(),
      sarvam: { configured: sarvamApiKeyPresent() },
      imd: { configured: Boolean(process.env.IMD_API_KEY?.trim()) },
      ndma: { configured: Boolean(process.env.NDMA_CAP_URL?.trim()) },
      incois: { configured: Boolean(process.env.INCOIS_API_ENDPOINT?.trim() && process.env.INCOIS_API_BASE_URL?.trim()) },
      openMeteo: { configured: true },
      nasaPower: { configured: true },
      scoutify: { configured: Boolean(process.env.SCOUTIFY_BASE_URL?.trim() && process.env.SCOUTIFY_API_KEY?.trim()) },
      restrictions: { configured: Boolean(process.env.FISHING_RESTRICTIONS_API_URL?.trim()) },
    },
    generatedAt: new Date().toISOString(),
  }));
}
