import type { ProviderResult } from "../types/fishing.js";
import { configured, fetchJson, unavailable } from "./http.js";

const PROVIDER = "Fishing restrictions API";

export async function getFishingRestrictions(
  latitude: number,
  longitude: number,
  waterMode: "marine" | "inland",
): Promise<ProviderResult<unknown>> {
  const endpoint = process.env.FISHING_RESTRICTIONS_API_URL?.trim();
  if (!configured(endpoint)) {
    return unavailable(PROVIDER, "No API-backed fishing restrictions source is configured.");
  }

  const url = new URL(endpoint as string);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("water_mode", waterMode);

  try {
    const apiKey = process.env.FISHING_RESTRICTIONS_API_KEY?.trim();
    const data = await fetchJson<unknown>(url.toString(), {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    return {
      provider: PROVIDER,
      status: "ok",
      data,
      warnings: [],
      evidence: [{
        provider: PROVIDER,
        title: "API-backed fishing restrictions",
        url: url.toString(),
        fetchedAt: new Date().toISOString(),
        status: "ok",
        stale: false,
      }],
    };
  } catch (error) {
    return {
      provider: PROVIDER,
      status: "error",
      warnings: [error instanceof Error ? error.message : "Fishing restrictions request failed."],
      evidence: [],
      error: error instanceof Error ? error.message : "Fishing restrictions request failed.",
    };
  }
}
