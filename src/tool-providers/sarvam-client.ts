import { SarvamAIClient } from "sarvamai";
import type { ProviderResult } from "../types/fishing.js";

const PROVIDER = "Sarvam AI";

const languageCodes: Record<string, string> = {
  assamese: "as-IN",
  bengali: "bn-IN",
  bodo: "brx-IN",
  dogri: "doi-IN",
  english: "en-IN",
  gujarati: "gu-IN",
  hindi: "hi-IN",
  kannada: "kn-IN",
  kashmiri: "ks-IN",
  konkani: "kok-IN",
  maithili: "mai-IN",
  malayalam: "ml-IN",
  manipuri: "mni-IN",
  marathi: "mr-IN",
  nepali: "ne-IN",
  odia: "od-IN",
  punjabi: "pa-IN",
  sanskrit: "sa-IN",
  santali: "sat-IN",
  sindhi: "sd-IN",
  tamil: "ta-IN",
  telugu: "te-IN",
  urdu: "ur-IN",
};

const mayuraLanguages = new Set([
  "bn-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
]);

export function sarvamApiKeyPresent(): boolean {
  return Boolean(process.env.SARVAM_API_KEY?.trim());
}

function requireKey(): string {
  const key = process.env.SARVAM_API_KEY?.trim();
  if (!key) throw new Error("SARVAM_API_KEY is not configured.");
  return key;
}

function client(): SarvamAIClient {
  return new SarvamAIClient({ apiSubscriptionKey: requireKey() });
}

export function languageCodeFor(language: string): string {
  return languageCodes[language.trim().toLowerCase()] ?? (language.includes("-") ? language : "en-IN");
}

function splitText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    const boundary = Math.max(
      remaining.lastIndexOf(". ", maxLength),
      remaining.lastIndexOf("? ", maxLength),
      remaining.lastIndexOf("! ", maxLength),
      remaining.lastIndexOf(" ", maxLength),
    );
    const cut = boundary > 0 ? boundary + 1 : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function translateToLanguage(
  text: string,
  language: string,
): Promise<ProviderResult<string>> {
  const target = languageCodeFor(language);
  if (!text.trim() || target === "en-IN") {
    return {
      provider: `${PROVIDER} Translation`,
      status: "ok",
      data: text,
      evidence: [],
      warnings: [],
    };
  }

  try {
    const model = mayuraLanguages.has(target) ? "mayura:v1" : "sarvam-translate:v1";
    const maxLength = model === "mayura:v1" ? 1000 : 2000;
    const outputs: string[] = [];

    for (const chunk of splitText(text, maxLength)) {
      const response = await client().text.translate({
        input: chunk,
        source_language_code: "en-IN",
        target_language_code: target as never,
        model,
        ...(model === "mayura:v1" ? { mode: "modern-colloquial" as const } : {}),
      });
      outputs.push(response.translated_text);
    }

    return {
      provider: `${PROVIDER} Translation`,
      status: "ok",
      data: outputs.join(" "),
      evidence: [{ provider: `${PROVIDER} Translation`, title: `Translated response to ${target}`, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
      warnings: [],
    };
  } catch (error) {
    return {
      provider: `${PROVIDER} Translation`,
      status: "error",
      evidence: [],
      warnings: [error instanceof Error ? error.message : "Sarvam translation failed."],
      error: error instanceof Error ? error.message : "Sarvam translation failed.",
    };
  }
}

type SttClient = SarvamAIClient["speechToTextRealtimeStreaming"];
type SttConnectArgs = Parameters<SttClient["connect"]>[0];
type TtsClient = SarvamAIClient["textToSpeechStreaming"];
type TtsConnectArgs = Parameters<TtsClient["connect"]>[0];

export async function createSarvamSttSocket(language: string) {
  const apiKey = requireKey();
  const socket = await client().speechToTextRealtimeStreaming.connect({
    language_code: languageCodeFor(language) as SttConnectArgs["language_code"],
    model: "saaras:v3-realtime",
    stream_type: "fast",
    mode: "translate",
    endpointing: "vad",
    encoding: "linear16",
    sample_rate: "16000",
    return_timestamps: "true",
    "Api-Subscription-Key": apiKey,
    reconnectAttempts: 0,
  });
  return socket;
}

export async function createSarvamTtsSocket() {
  const apiKey = requireKey();
  return client().textToSpeechStreaming.connect({
    model: "bulbul:v3",
    send_completion_event: "true",
    "Api-Subscription-Key": apiKey,
    reconnectAttempts: 0,
  } satisfies TtsConnectArgs);
}

export function ttsLanguageCode(language: string): string {
  const code = languageCodeFor(language);
  return Object.values(languageCodes).includes(code) ? code : "en-IN";
}
