import { XMLParser } from "fast-xml-parser";
import type {
  FisherLocation,
  OfficialAlert,
  OfficialSnapshot,
  ProviderResult,
} from "../types/fishing.js";
import { configured, unavailable } from "./http.js";

const PROVIDER = "NDMA SACHET";
let cachedEtag: string | undefined;
let cachedAlerts: OfficialAlert[] = [];

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return text((value as { "#text"?: unknown })["#text"]);
  return "";
}

function nestedText(value: Record<string, unknown>, key: string): string {
  return text(value[key]);
}

function findInfoNodes(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = node as Record<string, unknown>;
    if (record.info) {
      for (const info of asArray(record.info)) {
        if (info && typeof info === "object") found.push(info as Record<string, unknown>);
      }
    }

    for (const child of Object.values(record)) visit(child);
  };

  visit(value);
  return found;
}

function alertFromInfo(info: Record<string, unknown>, location: FisherLocation): OfficialAlert {
  const areaNodes = asArray(info.area);
  const areas = areaNodes.flatMap((area) => {
    if (!area || typeof area !== "object") return [];
    return [nestedText(area as Record<string, unknown>, "areaDesc")];
  }).filter(Boolean);
  const areaText = areas.join(", ");
  const locationText = `${location.label} ${location.latitude ?? ""} ${location.longitude ?? ""}`.toLowerCase();
  const relevant = !areaText || areaText.toLowerCase().split(/[^a-z0-9]+/).some((part) => part.length > 3 && locationText.includes(part));
  const event = nestedText(info, "event");
  const severity = nestedText(info, "severity");
  const description = nestedText(info, "description") || nestedText(info, "headline");
  const blocking = relevant && /extreme|severe|cyclone|tsunami|high\s+wave|swell|storm|lightning/i.test(`${event} ${severity} ${description}`);

  return {
    title: nestedText(info, "headline") || event || "NDMA alert",
    description: description || undefined,
    severity: severity || undefined,
    event: event || undefined,
    area: areaText || undefined,
    issuedAt: nestedText(info, "effective") || undefined,
    expiresAt: nestedText(info, "expires") || undefined,
    relevant,
    blocking,
  };
}

export async function getNdmaSnapshot(
  location: FisherLocation,
): Promise<ProviderResult<OfficialSnapshot>> {
  const url = process.env.NDMA_CAP_URL?.trim();
  if (!configured(url)) {
    return unavailable(PROVIDER, "NDMA SACHET CAP feed URL is not configured.");
  }

  try {
    const feedUrl = url as string;
    const headers: HeadersInit = { Accept: "application/xml, text/xml" };
    if (cachedEtag) headers["If-None-Match"] = cachedEtag;
    const response = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(8000) });

    if (response.status === 304) {
      return {
        provider: PROVIDER,
        status: "ok",
        data: { alerts: cachedAlerts, hasBlockingAlert: cachedAlerts.some((alert) => alert.blocking), records: cachedAlerts },
        evidence: [{ provider: PROVIDER, title: "Cached SACHET CAP alerts", url: feedUrl, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
        warnings: [],
      };
    }

    if (!response.ok) throw new Error(`${response.status} ${response.statusText || "SACHET request failed"}`);
    const xml = await response.text();
    cachedEtag = response.headers.get("etag") ?? cachedEtag;
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as unknown;
    const alerts = findInfoNodes(parsed).map((info) => alertFromInfo(info, location));
    cachedAlerts = alerts;

    return {
      provider: PROVIDER,
      status: "ok",
      data: { alerts, hasBlockingAlert: alerts.some((alert) => alert.blocking), records: [parsed] },
      evidence: [{ provider: PROVIDER, title: "SACHET CAP alert feed", url: feedUrl, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
      warnings: [],
    };
  } catch (error) {
    return {
      provider: PROVIDER,
      status: "error",
      evidence: [],
      warnings: [error instanceof Error ? error.message : "SACHET request failed."],
      error: error instanceof Error ? error.message : "SACHET request failed.",
    };
  }
}
