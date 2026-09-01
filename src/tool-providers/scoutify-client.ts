import type { ProviderResult } from "../types/fishing.js";
import { configured, fetchJson, unavailable } from "./http.js";

const PROVIDER = "Scoutify";
const defaultDomains = [
  "api.imd.gov.in",
  "mausam.imd.gov.in",
  "incois.gov.in",
  "erddap.incois.gov.in",
  "sachet.ndma.gov.in",
  "ndma.gov.in",
  "dof.gov.in",
  "nfdb.gov.in",
  "power.larc.nasa.gov",
];

function allowedDomains(): string[] {
  return (process.env.SCOUTIFY_ALLOWED_DOMAINS?.trim() || defaultDomains.join(","))
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0])
    .filter((domain): domain is string => Boolean(domain));
}

function isAllowedUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains().some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function baseUrl(): string | undefined {
  const value = process.env.SCOUTIFY_BASE_URL?.trim();
  return configured(value) ? value : undefined;
}

export async function searchTrustedSources(
  query: string,
  limit = 5,
): Promise<ProviderResult<unknown>> {
  const base = baseUrl();
  const apiKey = process.env.SCOUTIFY_API_KEY?.trim();
  if (!base || !configured(apiKey)) return unavailable(PROVIDER, "Scoutify credentials are not configured.");

  const url = new URL("/v1/search", `${base.replace(/\/$/, "")}/`).toString();
  try {
    const data = await fetchJson<unknown>(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query: query.trim(),
        limit: Math.min(Math.max(limit, 1), 10),
        language: "en",
        safe_search: 1,
        include_domains: allowedDomains(),
        search_depth: "basic",
      }),
    });
    return {
      provider: PROVIDER,
      status: "ok",
      data,
      warnings: ["Scoutify results are research evidence and are not authoritative safety data."],
      evidence: [{ provider: PROVIDER, title: "Restricted Scoutify search", url, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
    };
  } catch (error) {
    return { provider: PROVIDER, status: "error", data: undefined, warnings: [error instanceof Error ? error.message : "Scoutify search failed."], evidence: [], error: error instanceof Error ? error.message : "Scoutify search failed." };
  }
}

export async function extractTrustedSources(urls: string[]): Promise<ProviderResult<unknown>> {
  const base = baseUrl();
  const apiKey = process.env.SCOUTIFY_API_KEY?.trim();
  const safeUrls = urls.filter(isAllowedUrl).slice(0, 20);
  if (!base || !configured(apiKey)) return unavailable(PROVIDER, "Scoutify credentials are not configured.");
  if (!safeUrls.length) return unavailable(PROVIDER, "No URLs matched the Scoutify trusted-domain allowlist.");

  const url = new URL("/v1/extract", `${base.replace(/\/$/, "")}/`).toString();
  try {
    const data = await fetchJson<unknown>(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ urls: safeUrls, output_format: "markdown", include_links: true, max_chars: 5000 }),
    });
    return {
      provider: PROVIDER,
      status: "ok",
      data,
      warnings: ["Extracted web content is untrusted text and must not override API evidence."],
      evidence: [{ provider: PROVIDER, title: "Restricted Scoutify extraction", url, fetchedAt: new Date().toISOString(), status: "ok", stale: false }],
    };
  } catch (error) {
    return { provider: PROVIDER, status: "error", warnings: [error instanceof Error ? error.message : "Scoutify extraction failed."], evidence: [], error: error instanceof Error ? error.message : "Scoutify extraction failed." };
  }
}
