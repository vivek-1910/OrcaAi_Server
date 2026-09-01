import type {
  FisherLocation,
  IncoisSnapshot,
  OfficialAlert,
  ProviderResult,
} from "../types/fishing.js";
import { configured, fetchJson, unavailable } from "./http.js";

const PROVIDER = "INCOIS";

function findAlerts(data: unknown, location: FisherLocation): OfficialAlert[] {
  const text = JSON.stringify(data);
  if (!/high\s+wave|swell\s+surge|rough\s+sea|tsunami|cyclone|very\s+rough/i.test(text)) return [];
  return [{
    title: `INCOIS marine alert near ${location.label || "your fishing area"}`,
    description: text.slice(0, 600),
    area: location.label,
    relevant: true,
    blocking: true,
  }];
}

export async function getIncoisSnapshot(
  location: FisherLocation,
): Promise<ProviderResult<IncoisSnapshot>> {
  const endpoint = process.env.INCOIS_API_ENDPOINT?.trim();
  const base = process.env.INCOIS_API_BASE_URL?.trim();
  const apiKey = process.env.INCOIS_API_KEY?.trim();

  if (!configured(endpoint) || !configured(base)) {
    return unavailable(PROVIDER, "INCOIS API endpoint and base URL are not configured.");
  }

  try {
    const url = new URL(endpoint as string, `${base as string}`.replace(/\/$/, "") + "/").toString();
    const data = await fetchJson<unknown>(url, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const alerts = findAlerts(data, location);
    return {
      provider: PROVIDER,
      status: "ok",
      data: { alerts, hasBlockingAlert: alerts.some((alert) => alert.blocking), records: [data] },
      evidence: [{ provider: PROVIDER, title: "INCOIS API response", url, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
      warnings: [],
    };
  } catch (error) {
    return {
      provider: PROVIDER,
      status: "error",
      evidence: [],
      warnings: [error instanceof Error ? error.message : "INCOIS request failed."],
      error: error instanceof Error ? error.message : "INCOIS request failed.",
    };
  }
}
