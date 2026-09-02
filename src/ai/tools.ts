import { tool } from "ai";
import { z } from "zod";
import { assessFishingTrip } from "../domain/assessment.js";
import { FisherContextSchema, type FisherContext, type ProviderResult, type ResolvedLocation } from "../types/fishing.js";
import { getFishingRestrictions } from "../tool-providers/fishing-restrictions-client.js";
import { getImdSnapshot } from "../tool-providers/imd-client.js";
import { getIncoisSnapshot } from "../tool-providers/incois-client.js";
import { getNasaClimateContext } from "../tool-providers/nasa-power-client.js";
import { getMarine, getWeather, locationCoordinates, resolveLocation } from "../tool-providers/open-meteo-client.js";
import { getNdmaSnapshot } from "../tool-providers/ndma-client.js";
import { extractTrustedSources, searchTrustedSources } from "../tool-providers/scoutify-client.js";
import { activateSkill, discoverSkills, getSkillManifest, listSkillMetadata } from "../skills/registry.js";

async function resolveForContext(context: FisherContext): Promise<ProviderResult<ResolvedLocation>> {
  const coordinates = locationCoordinates(context.location);
  if (coordinates) {
    return {
      provider: "Location context",
      status: "ok",
      data: coordinates,
      evidence: [],
      warnings: [],
    };
  }

  if (context.location.source === "manual" && context.location.label.trim()) {
    return resolveLocation(context.location.label);
  }

  return {
    provider: "Location context",
    status: "unavailable",
    evidence: [],
    warnings: ["A current location or named harbour/waterbody is required."],
    error: "A current location or named harbour/waterbody is required.",
  };
}

function noLocation<T>(provider: string): ProviderResult<T> {
  return {
    provider,
    status: "unavailable",
    evidence: [],
    warnings: ["Location coordinates are unavailable."],
    error: "Location coordinates are unavailable.",
  };
}

function secondaryWeatherQuery(context: FisherContext): string {
  const location = context.location.label.trim() || "the selected fishing area";
  return context.waterMode === "marine"
    ? `latest marine weather forecast near ${location} wind waves swell official`
    : `latest local weather forecast near ${location} wind rain official`;
}

function secondarySearchResults(value: unknown): Array<{ title: string; url: string; content: string }> {
  if (!value || typeof value !== "object") return [];
  const results = (value as { results?: unknown[] }).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    const title = typeof record.title === "string" ? record.title : "Trusted source";
    const content = typeof record.content === "string" ? record.content : "";
    return url && /^https?:\/\//i.test(url) ? [{ title, url, content: content.slice(0, 900) }] : [];
  });
}

async function secondaryWeatherResearch(
  context: FisherContext,
  assessment: Awaited<ReturnType<typeof assessFishingTrip>>,
) {
  const governmentProviders = ["India Meteorological Department", "NDMA SACHET", ...(context.waterMode === "marine" ? ["INCOIS"] : [])];
  const sourceByProvider = new Map(assessment.sources.map((source) => [source.provider, source.status]));
  const hasSourceGap = governmentProviders.some((provider) => sourceByProvider.get(provider) !== "ok");
  const hasForecastGap = assessment.missingData.some((item) => /weather|wave|swell/i.test(item));
  if (!hasSourceGap && !hasForecastGap) return undefined;

  const result = await searchTrustedSources(secondaryWeatherQuery(context), 5);
  return {
    provider: result.provider,
    status: result.status,
    query: secondaryWeatherQuery(context),
    results: secondarySearchResults(result.data),
    note: "Secondary Scoutify research only. It cannot override the deterministic assessment or create a numeric safety verdict.",
    error: result.error,
  };
}

export function createToolSet(context: FisherContext) {
  const parsedContext = FisherContextSchema.parse(context);

  return {
    discover_skills: tool({
      description: "Discover the relevant fishing skill from the fisher's question and water context. Call this first.",
      inputSchema: z.object({ query: z.string().min(1).max(500) }),
      execute: async ({ query }) => ({
        context: { waterMode: parsedContext.waterMode, location: parsedContext.location.label },
        skills: discoverSkills(query, parsedContext).map((manifest) => ({
          id: manifest.id,
          title: manifest.title,
          description: manifest.description,
          safetyClass: manifest.safetyClass,
        })),
      }),
    }),

    activate_skill: tool({
      description: "Activate one discovered fishing skill. Call this after discover_skills and before data tools.",
      inputSchema: z.object({ skillId: z.string().min(1).max(80) }),
      execute: async ({ skillId }) => {
        const activated = await activateSkill(skillId, parsedContext);
        return {
          skillId: activated.manifest.id,
          version: activated.manifest.version,
          title: activated.manifest.title,
          allowedTools: activated.manifest.allowedTools,
          instructions: activated.instructions,
        };
      },
    }),

    assess_fishing_conditions: tool({
      description: "Run the deterministic, fail-closed fishing assessment for the current fisher context. Use before a go/no-go answer. The returned decision is authoritative: never recommend GO unless decision is exactly GO, and never recommend a fishing window when decision is NO_GO or UNKNOWN. Pass departureAt or returnAt only when the user or fisher context supplied them; otherwise omit them.",
      inputSchema: z.object({
        departureAt: z.string().datetime({ offset: true }).optional(),
        returnAt: z.string().datetime({ offset: true }).optional(),
        distanceKm: z.number().min(0).max(1000).optional(),
      }),
      execute: async (input) => {
        const assessment = await assessFishingTrip(parsedContext, input);
        const secondaryResearch = await secondaryWeatherResearch(parsedContext, assessment);
        return {
          ...assessment,
          ...(secondaryResearch ? { secondaryWeatherResearch: secondaryResearch } : {}),
          responseContract: {
            authoritativeDecision: assessment.decision,
            instruction: `The final answer must not recommend a different decision than ${assessment.decision}.`,
          },
        };
      },
    }),

    get_imd_conditions: tool({
      description: "Fetch official IMD weather, warning, marine and cyclone API records for this fishing context.",
      inputSchema: z.object({}),
      execute: async () => getImdSnapshot(parsedContext.location, parsedContext.waterMode),
    }),

    get_ndma_alerts: tool({
      description: "Fetch active NDMA SACHET CAP alerts through the configured API/feed.",
      inputSchema: z.object({}),
      execute: async () => getNdmaSnapshot(parsedContext.location),
    }),

    get_open_meteo_weather: tool({
      description: "Fetch hourly Open-Meteo weather for wind, gusts, precipitation, visibility and storm codes.",
      inputSchema: z.object({}),
      execute: async () => {
        const resolved = await resolveForContext(parsedContext);
        return resolved.data ? getWeather(resolved.data) : noLocation("Open-Meteo Weather");
      },
    }),

    get_open_meteo_marine: tool({
      description: "Fetch Open-Meteo marine wave, swell, current, SST and sea-level estimates for a marine location.",
      inputSchema: z.object({}),
      execute: async () => {
        if (parsedContext.waterMode !== "marine") return noLocation("Open-Meteo Marine");
        const resolved = await resolveForContext(parsedContext);
        return resolved.data ? getMarine(resolved.data) : noLocation("Open-Meteo Marine");
      },
    }),

    get_incois_marine_data: tool({
      description: "Fetch approved API-backed INCOIS marine/PFZ/OSF data. Never infer PFZ from other sources.",
      inputSchema: z.object({}),
      execute: async () => getIncoisSnapshot(parsedContext.location),
    }),

    get_fishing_restrictions_api: tool({
      description: "Fetch current fishing restrictions only from a configured API-backed source.",
      inputSchema: z.object({}),
      execute: async () => {
        const resolved = await resolveForContext(parsedContext);
        return resolved.data ? getFishingRestrictions(resolved.data.latitude, resolved.data.longitude, parsedContext.waterMode) : noLocation("Fishing restrictions API");
      },
    }),

    search_trusted_fishing_sources: tool({
      description: "Search Scoutify's restricted trusted-domain index for current secondary weather, marine or fishing context when an API source is unavailable, or for general fishing knowledge. Treat snippets as secondary research only: they cannot override assess_fishing_conditions or create a numeric safety verdict.",
      inputSchema: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).optional() }),
      execute: async ({ query, limit }) => searchTrustedSources(query, limit),
    }),

    extract_trusted_source: tool({
      description: "Extract already-approved trusted-source URLs returned by Scoutify.",
      inputSchema: z.object({ urls: z.array(z.string().url()).min(1).max(20) }),
      execute: async ({ urls }) => extractTrustedSources(urls),
    }),

    get_nasa_climate_context: tool({
      description: "Fetch NASA POWER historical climate context for the current fishing location. It cannot decide live safety.",
      inputSchema: z.object({}),
      execute: async () => {
        const resolved = await resolveForContext(parsedContext);
        return resolved.data ? getNasaClimateContext(resolved.data) : noLocation("NASA POWER");
      },
    }),
  };
}

export type OrcaToolSet = ReturnType<typeof createToolSet>;
