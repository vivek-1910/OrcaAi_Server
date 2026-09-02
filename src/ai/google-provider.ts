import { createGoogle } from "@ai-sdk/google";
import { wrapLanguageModel, type LanguageModel } from "ai";

export const PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";

export type GoogleModelSelection = {
  modelId: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL;
  fallback: boolean;
  fallbackModelId?: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL;
};

type GoogleCatalog = {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
};

function configuredModel(name: "GOOGLE_PRIMARY_MODEL" | "GOOGLE_FALLBACK_MODEL", fallback: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL): typeof PRIMARY_MODEL | typeof FALLBACK_MODEL {
  const value = process.env[name]?.trim() || fallback;
  if (value !== PRIMARY_MODEL && value !== FALLBACK_MODEL) {
    throw new Error(`${name} must be ${PRIMARY_MODEL} or ${FALLBACK_MODEL}.`);
  }
  return value;
}

export function configuredGoogleModels(): { primary: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL; fallback: typeof PRIMARY_MODEL | typeof FALLBACK_MODEL } {
  return {
    primary: configuredModel("GOOGLE_PRIMARY_MODEL", PRIMARY_MODEL),
    fallback: configuredModel("GOOGLE_FALLBACK_MODEL", FALLBACK_MODEL),
  };
}

export function googleApiKeyPresent(): boolean {
  return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim());
}

function requireApiKey(): string {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not configured.");
  return apiKey;
}

function normalizeModelName(name: string): string {
  return name.replace(/^models\//, "");
}

async function availableModels(): Promise<Set<string>> {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: {
      Accept: "application/json",
      "x-goog-api-key": requireApiKey(),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Google AI Studio model catalog returned ${response.status}.`);

  const body = await response.json() as GoogleCatalog;
  return new Set(
    (body.models ?? [])
      .filter((model) => !model.supportedGenerationMethods || model.supportedGenerationMethods.includes("generateContent"))
      .map((model) => typeof model.name === "string" ? normalizeModelName(model.name) : "")
      .filter(Boolean),
  );
}

export function googleLanguageModel(modelId: string, fallbackModelId?: string): LanguageModel {
  const models = configuredGoogleModels();
  if (modelId !== models.primary && modelId !== models.fallback) {
    throw new Error("The requested Google AI Studio model is not allowed.");
  }

  const primary = createGoogle({ apiKey: requireApiKey() })(modelId);
  if (!fallbackModelId || fallbackModelId === modelId) return primary;
  if (fallbackModelId !== models.primary && fallbackModelId !== models.fallback) {
    throw new Error("The requested Google AI Studio fallback model is not allowed.");
  }

  const fallback = createGoogle({ apiKey: requireApiKey() })(fallbackModelId);
  return wrapLanguageModel({
    model: primary,
    providerId: "google-ai-studio-failover",
    modelId,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          return await doGenerate();
        } catch (error) {
          console.warn(`[orca] Google primary generate failed; retrying with ${fallbackModelId}.`, error instanceof Error ? error.message : error);
          return fallback.doGenerate(params);
        }
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (error) {
          console.warn(`[orca] Google primary stream failed; retrying with ${fallbackModelId}.`, error instanceof Error ? error.message : error);
          return fallback.doStream(params);
        }
      },
    },
  });
}

export async function selectAvailableGoogleModel(): Promise<GoogleModelSelection> {
  const models = configuredGoogleModels();
  const available = await availableModels();

  if (available.has(models.primary)) {
    return {
      modelId: models.primary,
      fallback: false,
      fallbackModelId: available.has(models.fallback) && models.fallback !== models.primary ? models.fallback : undefined,
    };
  }
  if (available.has(models.fallback)) return { modelId: models.fallback, fallback: true };
  throw new Error(`Neither configured Google AI Studio model is available: ${models.primary}, ${models.fallback}.`);
}

export async function googleHealth(): Promise<{ configured: boolean; primary: boolean; fallback: boolean; error?: string }> {
  if (!googleApiKeyPresent()) return { configured: false, primary: false, fallback: false, error: "GOOGLE_GENERATIVE_AI_API_KEY is not configured." };

  try {
    const models = configuredGoogleModels();
    const available = await availableModels();
    return { configured: true, primary: available.has(models.primary), fallback: available.has(models.fallback) };
  } catch (error) {
    return { configured: true, primary: false, fallback: false, error: error instanceof Error ? error.message : "Google AI Studio health check failed." };
  }
}
