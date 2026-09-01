import { createGroq } from "@ai-sdk/groq";
import { wrapLanguageModel, type LanguageModel } from "ai";

export const PRIMARY_MODEL = "openai/gpt-oss-120b";
export const FALLBACK_MODEL = "qwen/qwen3.8-27b";

export type GroqModelSelection = {
  modelId: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL;
  fallback: boolean;
  fallbackModelId?: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL;
};

function configuredModel(name: "GROQ_PRIMARY_MODEL" | "GROQ_FALLBACK_MODEL", fallback: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL): typeof PRIMARY_MODEL | typeof FALLBACK_MODEL {
  const value = process.env[name]?.trim() || fallback;
  if (value !== PRIMARY_MODEL && value !== FALLBACK_MODEL) {
    throw new Error(`${name} must be ${PRIMARY_MODEL} or ${FALLBACK_MODEL}.`);
  }
  return value;
}

export function configuredGroqModels(): { primary: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL; fallback: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL } {
  return {
    primary: configuredModel("GROQ_PRIMARY_MODEL", PRIMARY_MODEL),
    fallback: configuredModel("GROQ_FALLBACK_MODEL", FALLBACK_MODEL),
  };
}

export function groqApiKeyPresent(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

export function groqLanguageModel(modelId: string, fallbackModelId?: string): LanguageModel {
  const models = configuredGroqModels();
  if (modelId !== models.primary && modelId !== models.fallback) {
    throw new Error("The requested Groq model is not allowed.");
  }

  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");

  const primary = createGroq({ apiKey })(modelId);
  if (!fallbackModelId || fallbackModelId === modelId) return primary;
  if (fallbackModelId !== models.primary && fallbackModelId !== models.fallback) {
    throw new Error("The requested Groq fallback model is not allowed.");
  }

  const fallback = createGroq({ apiKey })(fallbackModelId);
  return wrapLanguageModel({
    model: primary,
    providerId: "groq-failover",
    modelId,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (error) {
          console.warn(`[orca] Groq primary generate failed; retrying with ${fallbackModelId}.`, error instanceof Error ? error.message : error);
          return fallback.doGenerate(params);
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (error) {
          console.warn(`[orca] Groq primary stream failed; retrying with ${fallbackModelId}.`, error instanceof Error ? error.message : error);
          return fallback.doStream(params);
        }
      },
    },
  });
}

export async function selectAvailableGroqModel(): Promise<GroqModelSelection> {
  const models = configuredGroqModels();
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured.");

  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Groq model catalog returned ${response.status}.`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  const available = new Set((body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)));

  if (available.has(models.primary)) {
    return {
      modelId: models.primary,
      fallback: false,
      fallbackModelId: available.has(models.fallback) && models.fallback !== models.primary ? models.fallback : undefined,
    };
  }
  if (available.has(models.fallback)) return { modelId: models.fallback, fallback: true };
  throw new Error(`Neither configured Groq model is available: ${models.primary}, ${models.fallback}.`);
}

export async function groqHealth(): Promise<{ configured: boolean; primary: boolean; fallback: boolean; error?: string }> {
  if (!groqApiKeyPresent()) return { configured: false, primary: false, fallback: false, error: "GROQ_API_KEY is not configured." };

  try {
    const models = configuredGroqModels();
    const apiKey = process.env.GROQ_API_KEY?.trim();
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { configured: true, primary: false, fallback: false, error: `Groq model catalog returned ${response.status}.` };
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const ids = new Set((body.data ?? []).map((model) => model.id));
    return { configured: true, primary: ids.has(models.primary), fallback: ids.has(models.fallback) };
  } catch (error) {
    return { configured: true, primary: false, fallback: false, error: error instanceof Error ? error.message : "Groq health check failed." };
  }
}
