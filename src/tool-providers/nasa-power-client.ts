import type { ProviderResult, ResolvedLocation } from "../types/fishing.js";
import { fetchJson } from "./http.js";

const PROVIDER = "NASA POWER";

function datePart(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export async function getNasaClimateContext(
  location: ResolvedLocation,
): Promise<ProviderResult<unknown>> {
  const base = process.env.NASA_POWER_BASE_URL?.trim() || "https://power.larc.nasa.gov";
  const end = new Date();
  const start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000);
  const url = new URL("/api/temporal/daily/point", `${base.replace(/\/$/, "")}/`);
  url.searchParams.set("parameters", "T2M,WS10M,PRECTOTCORR");
  url.searchParams.set("community", "AG");
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("start", datePart(start));
  url.searchParams.set("end", datePart(end));
  url.searchParams.set("format", "JSON");

  try {
    const data = await fetchJson<unknown>(url.toString());
    return {
      provider: PROVIDER,
      status: "ok",
      data,
      warnings: ["NASA POWER is historical/climate context, not an operational fishing-safety forecast."],
      evidence: [{ provider: PROVIDER, title: `NASA POWER context near ${location.label}`, url: url.toString(), fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
    };
  } catch (error) {
    return { provider: PROVIDER, status: "error", warnings: [error instanceof Error ? error.message : "NASA POWER request failed."], evidence: [], error: error instanceof Error ? error.message : "NASA POWER request failed." };
  }
}
