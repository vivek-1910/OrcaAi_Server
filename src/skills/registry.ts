import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FisherContext, SkillId, SkillManifest, WaterMode } from "../types/fishing.js";

const manifests: SkillManifest[] = [
  {
    id: "fishing-safety",
    version: "0.1.0",
    title: "Fishing safety assessment",
    description: "Evaluate whether a marine or inland fishing window is currently verifiable for the fisher profile.",
    waterModes: ["marine", "inland"],
    triggers: ["go fishing", "should i go", "can i fish", "safe to launch", "fishing tomorrow"],
    requiredContext: ["waterMode", "location", "vessel", "experience"],
    allowedTools: ["assess_fishing_conditions"],
    safetyClass: "decision",
  },
  {
    id: "fishing-conditions",
    version: "0.1.0",
    title: "Fishing conditions",
    description: "Inspect local weather, marine conditions and official alerts for the selected fishing area.",
    waterModes: ["marine", "inland"],
    triggers: ["weather", "wind", "wave", "swell", "sea condition", "water condition", "rain", "storm"],
    requiredContext: ["location", "waterMode"],
    allowedTools: ["get_imd_conditions", "get_ndma_alerts", "get_open_meteo_weather", "get_open_meteo_marine", "get_incois_marine_data"],
    safetyClass: "information",
  },
  {
    id: "fishing-regulations",
    version: "0.1.0",
    title: "Fishing restrictions",
    description: "Check API-backed fishing restrictions for the selected location and water type.",
    waterModes: ["marine", "inland"],
    triggers: ["allowed", "ban", "closed season", "regulation", "permit", "legal to fish"],
    requiredContext: ["location", "waterMode"],
    allowedTools: ["get_fishing_restrictions_api"],
    safetyClass: "decision",
  },
  {
    id: "fishing-pfz",
    version: "0.1.0",
    title: "Potential fishing zone",
    description: "Retrieve an approved INCOIS API-backed Potential Fishing Zone advisory when available.",
    waterModes: ["marine"],
    triggers: ["pfz", "potential fishing zone", "where are fish", "fish zone", "fishing area"],
    requiredContext: ["location", "waterMode"],
    allowedTools: ["get_incois_marine_data"],
    safetyClass: "information",
  },
  {
    id: "fishing-briefing",
    version: "0.1.0",
    title: "Pre-departure fishing briefing",
    description: "Give a concise fishing-specific briefing and checklist using the current assessment.",
    waterModes: ["marine", "inland"],
    triggers: ["brief", "checklist", "before i go", "prepare", "departure"],
    requiredContext: ["location", "waterMode", "vessel"],
    allowedTools: ["assess_fishing_conditions"],
    safetyClass: "briefing",
  },
  {
    id: "fishing-knowledge",
    version: "0.1.0",
    title: "Fishing knowledge",
    description: "Answer general fishing questions with restricted Scoutify research and optional NASA context.",
    waterModes: ["marine", "inland"],
    triggers: ["how do i", "what bait", "which fish", "gear", "tackle", "technique", "explain"],
    requiredContext: [],
    allowedTools: ["search_trusted_fishing_sources", "extract_trusted_source", "get_nasa_climate_context"],
    safetyClass: "information",
  },
];

const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));

function normalize(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function containsPhrase(query: string, phrase: string): boolean {
  const normalizedQuery = normalize(query);
  const normalizedPhrase = normalize(phrase);
  return Boolean(normalizedPhrase) && ` ${normalizedQuery} `.includes(` ${normalizedPhrase} `);
}

function containsWord(query: string, words: RegExp): boolean {
  return words.test(` ${normalize(query)} `);
}

export function listSkillMetadata(waterMode?: WaterMode): SkillManifest[] {
  return manifests.filter((manifest) => !waterMode || manifest.waterModes.includes(waterMode));
}

export function getSkillManifest(skillId: string): SkillManifest | undefined {
  return manifestById.get(skillId as SkillId);
}

export function discoverSkills(query: string, context: FisherContext): SkillManifest[] {
  const normalized = normalize(query);
  const matches = listSkillMetadata(context.waterMode).map((manifest) => {
    const score = manifest.triggers.reduce((total, trigger) => total + (containsPhrase(normalized, trigger) ? 2 : 0), 0);
    const safetyBoost = manifest.id === "fishing-safety" && containsWord(normalized, /\b(go|safe|should|tomorrow|today|launch|trip|window|when|best)\b/) ? 4 : 0;
    const conditionBoost = manifest.id === "fishing-conditions" && containsWord(normalized, /\b(weather|wind|wave|rain|storm|sea|water)\b/) ? 3 : 0;
    const knowledgeBoost = manifest.id === "fishing-knowledge" && containsWord(normalized, /\b(how|bait|gear|tackle|fish|technique)\b/) ? 3 : 0;
    return { manifest, score: score + safetyBoost + conditionBoost + knowledgeBoost };
  });

  matches.sort((left, right) => right.score - left.score || left.manifest.id.localeCompare(right.manifest.id));
  const selected = matches.filter((entry) => entry.score > 0).map((entry) => entry.manifest);
  return selected.length ? selected.slice(0, 3) : [manifestById.get("fishing-safety")!];
}

export function allowedToolsFor(skillId: string, waterMode: WaterMode): string[] {
  const manifest = getSkillManifest(skillId);
  if (!manifest || !manifest.waterModes.includes(waterMode)) return ["assess_fishing_conditions"];
  return manifest.allowedTools.filter((toolName) => waterMode === "marine" || !["get_open_meteo_marine", "get_incois_marine_data"].includes(toolName));
}

export async function activateSkill(skillId: string, context: FisherContext): Promise<{
  manifest: SkillManifest;
  instructions: string;
}> {
  const manifest = getSkillManifest(skillId);
  if (!manifest || !manifest.waterModes.includes(context.waterMode)) {
    throw new Error(`Skill ${skillId} is not available for ${context.waterMode} fishing.`);
  }

  const path = join(process.cwd(), "src", "skills", manifest.id, "SKILL.md");
  const instructions = await readFile(path, "utf8");
  return { manifest, instructions };
}
