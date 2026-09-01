import type {
  FisherLocation,
  OfficialAlert,
  OfficialSnapshot,
  ProviderResult,
  WaterMode,
} from "../types/fishing.js";
import { configured, fetchJson, unavailable } from "./http.js";

const PROVIDER = "India Meteorological Department";

const blockingPattern = /cyclone|tsunami|high\s+wave|swell\s+surge|red\s+alert|very\s+severe|extremely\s+severe|thunderstorm|lightning|squall/i;

function asText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(asText).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(asText).join(" ");
  return "";
}

function buildAlert(record: unknown, location: FisherLocation): OfficialAlert | undefined {
  const text = asText(record);
  if (!blockingPattern.test(text)) return undefined;

  return {
    title: `${PROVIDER} warning near ${location.label || "your fishing area"}`,
    description: text.slice(0, 600),
    event: text.match(blockingPattern)?.[0],
    area: location.label,
    relevant: true,
    blocking: true,
  };
}

function pathList(waterMode: WaterMode): string[] {
  const common = [
    "/api/v1/current_wx",
    "/api/v1/districtnowcast",
    "/api/v1/districtwarning",
    "/api/v1/cyclone_track",
    "/api/v1/cyclone_wind",
  ];

  if (waterMode === "marine") {
    common.push("/api/v1/portwarning", "/api/v1/seabulletin", "/api/v1/coastalbulletin");
  }

  return common;
}

export async function getImdSnapshot(
  location: FisherLocation,
  waterMode: WaterMode,
): Promise<ProviderResult<OfficialSnapshot>> {
  const base = process.env.IMD_API_BASE_URL?.trim() || "https://api.imd.gov.in";
  const apiKey = process.env.IMD_API_KEY?.trim();

  if (!configured(apiKey)) {
    return unavailable(PROVIDER, "IMD API credentials are not configured.");
  }

  const paths = pathList(waterMode);
  const results = await Promise.allSettled(
    paths.map(async (path) => {
      const url = new URL(path, `${base.replace(/\/$/, "")}/`).toString();
      const data = await fetchJson<unknown>(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });
      return { path, url, data };
    }),
  );

  const records: unknown[] = [];
  const evidence = [];
  const warnings: string[] = [];
  const alerts: OfficialAlert[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      records.push(result.value.data);
      evidence.push({
        provider: PROVIDER,
        title: `IMD ${result.value.path}`,
        url: result.value.url,
        fetchedAt: new Date().toISOString(),
        status: "ok" as const,
        stale: false,
      });
      const alert = buildAlert(result.value.data, location);
      if (alert) alerts.push(alert);
    } else {
      warnings.push(result.reason instanceof Error ? result.reason.message : "IMD endpoint failed.");
    }
  }

  if (!records.length) {
    return {
      provider: PROVIDER,
      status: "error",
      evidence,
      warnings,
      error: warnings[0] ?? "IMD APIs did not return data.",
    };
  }

  return {
    provider: PROVIDER,
    status: "ok",
    data: {
      alerts,
      hasBlockingAlert: alerts.some((alert) => alert.blocking),
      records,
    },
    evidence,
    warnings,
  };
}
