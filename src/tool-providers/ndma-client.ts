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

function localNameMatches(key: string, name: string): boolean {
  return key === name || key.endsWith(`:${name}`);
}

function nestedText(value: Record<string, unknown>, key: string): string {
  const entry = Object.entries(value).find(([name]) => localNameMatches(name, key));
  return entry ? text(entry[1]) : "";
}

function findNodes(value: unknown, name: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (localNameMatches(key, name)) {
        for (const item of asArray(child)) {
          if (item && typeof item === "object") found.push(item as Record<string, unknown>);
        }
      } else {
        visit(child);
      }
    }
  };

  visit(value);
  return found;
}

function findInfoNodes(value: unknown): Array<Record<string, unknown>> {
  return findNodes(value, "info");
}

function locationMatches(areaText: string, location: FisherLocation): boolean {
  const locationText = `${location.label} ${location.latitude ?? ""} ${location.longitude ?? ""}`.toLowerCase();
  const areaTokens = areaText.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 3);
  return !areaText || areaTokens.some((part) => locationText.includes(part));
}

function alertFromInfo(info: Record<string, unknown>, location: FisherLocation): OfficialAlert {
  const areas = findNodes(info, "area").map((area) => nestedText(area, "areaDesc")).filter(Boolean);
  const areaText = areas.join(", ");
  const relevant = locationMatches(areaText, location);
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

function alertFromRssItem(item: Record<string, unknown>, location: FisherLocation): OfficialAlert {
  const title = nestedText(item, "title") || "NDMA alert";
  const description = nestedText(item, "description");
  const author = nestedText(item, "author");
  const category = nestedText(item, "category");
  const relevantText = `${title} ${description} ${author}`;
  const relevant = locationMatches(title, location);
  const blocking = relevant && /extreme|severe|cyclone|tsunami|high\s+wave|swell\s+surge|storm|lightning/i.test(relevantText);

  return {
    title,
    description: description || undefined,
    severity: relevantText.match(/extreme|severe|moderate|minor/i)?.[0],
    event: category || undefined,
    area: title,
    issuedAt: nestedText(item, "pubDate") || undefined,
    relevant,
    blocking,
  };
}

function sameOriginUrl(value: string, base: string): string | undefined {
  try {
    const candidate = new URL(value, base);
    if (candidate.origin !== new URL(base).origin) return undefined;
    return candidate.toString();
  } catch {
    return undefined;
  }
}

async function alertsFromRssItems(
  items: Array<Record<string, unknown>>,
  location: FisherLocation,
  feedUrl: string,
): Promise<{ alerts: OfficialAlert[]; detailFailures: number }> {
  const selectedItems = items.slice(0, 25);
  const results = await Promise.allSettled(selectedItems.map(async (item) => {
    const fallback = alertFromRssItem(item, location);
    const link = sameOriginUrl(nestedText(item, "link"), feedUrl);
    if (!link) return [fallback];

    try {
      const response = await fetch(link, {
        headers: { Accept: "application/xml, text/xml" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return [fallback];
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(await response.text()) as unknown;
      const infos = findInfoNodes(parsed);
      return infos.length ? infos.map((info) => alertFromInfo(info, location)) : [fallback];
    } catch {
      return [fallback];
    }
  }));

  const alerts: OfficialAlert[] = [];
  let detailFailures = 0;
  results.forEach((result) => {
    if (result.status === "fulfilled") alerts.push(...result.value);
    else detailFailures += 1;
  });

  return { alerts, detailFailures };
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
    const capAlerts = findInfoNodes(parsed);
    const rssItems = findNodes(parsed, "item");
    const rssResult = rssItems.length ? await alertsFromRssItems(rssItems, location, feedUrl) : { alerts: [], detailFailures: 0 };
    const alerts = capAlerts.length
      ? capAlerts.map((info) => alertFromInfo(info, location))
      : rssResult.alerts;
    cachedAlerts = alerts;

    return {
      provider: PROVIDER,
      status: "ok",
      data: { alerts, hasBlockingAlert: alerts.some((alert) => alert.blocking), records: [parsed] },
      evidence: [{ provider: PROVIDER, title: "SACHET CAP alert feed", url: feedUrl, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
      warnings: rssResult.detailFailures ? [`${rssResult.detailFailures} SACHET alert details could not be expanded.`] : [],
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
