import type {
  FisherContext,
  FishingAssessment,
  MarineData,
  OfficialAlert,
  ProviderResult,
  ResolvedLocation,
  WeatherData,
} from "../types/fishing.js";
import { FishingAssessmentSchema, type IncoisSnapshot, type OfficialSnapshot } from "../types/fishing.js";

type SafetyPolicy = {
  maxWindKph: number;
  maxGustKph: number;
  maxWaveHeightM?: number;
  maxSwellHeightM?: number;
  minVisibilityM: number;
};

export type SafetyInputs = {
  context: FisherContext;
  location: ResolvedLocation;
  weather: ProviderResult<WeatherData>;
  marine?: ProviderResult<MarineData>;
  imd: ProviderResult<OfficialSnapshot>;
  ndma: ProviderResult<OfficialSnapshot>;
  incois?: ProviderResult<IncoisSnapshot>;
  restrictions?: ProviderResult<unknown>;
  now?: Date;
};

const POLICY_VERSION = "prototype-0.1-unvalidated";

function policyFor(context: FisherContext): SafetyPolicy {
  const vessel = context.vessel.type.toLowerCase();

  if (vessel.includes("kayak")) {
    return { maxWindKph: 18, maxGustKph: 25, maxWaveHeightM: 0.8, maxSwellHeightM: 0.6, minVisibilityM: 1500 };
  }

  if (vessel.includes("shore") || vessel.includes("bank")) {
    return { maxWindKph: 35, maxGustKph: 50, minVisibilityM: 1000 };
  }

  if (vessel.includes("commercial")) {
    return { maxWindKph: 45, maxGustKph: 65, maxWaveHeightM: 2.5, maxSwellHeightM: 2, minVisibilityM: 1500 };
  }

  return { maxWindKph: 25, maxGustKph: 35, maxWaveHeightM: 1.2, maxSwellHeightM: 1, minVisibilityM: 1200 };
}

function resultState(decision: FishingAssessment["decision"]): FishingAssessment["state"] {
  if (decision === "GO") return "go";
  if (decision === "CAUTION") return "caution";
  if (decision === "NO_GO") return "avoid";
  return "wait";
}

function titleFor(decision: FishingAssessment["decision"]): string {
  if (decision === "GO") return "Conditions support a fishing trip";
  if (decision === "CAUTION") return "Use a cautious fishing plan";
  if (decision === "NO_GO") return "Do not launch yet";
  return "Wait for a verified fishing window";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function futureIso(now: Date, hours: number): string {
  return new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function alertList(inputs: SafetyInputs): OfficialAlert[] {
  return [
    ...(inputs.imd.data?.alerts ?? []),
    ...(inputs.ndma.data?.alerts.filter((alert) => alert.relevant) ?? []),
    ...(inputs.incois?.data?.alerts.filter((alert) => alert.relevant) ?? []),
  ];
}

export function evaluateFishingSafety(inputs: SafetyInputs): FishingAssessment {
  const now = inputs.now ?? new Date();
  const policy = policyFor(inputs.context);
  const weather = inputs.weather.data;
  const marine = inputs.marine?.data;
  const alerts = alertList(inputs);
  const blockingReasons: string[] = [];
  const riskFactors: string[] = [];
  const missingData: string[] = [];

  if (alerts.some((alert) => alert.blocking)) {
    blockingReasons.push("An official warning is active for this fishing context.");
  }

  if (inputs.weather.status !== "ok" || !weather) {
    missingData.push("local weather forecast");
  }

  if (inputs.context.waterMode === "marine" && (inputs.marine?.status !== "ok" || !marine)) {
    missingData.push("marine wave and swell forecast");
  }

  const hasOfficialCoverage = inputs.imd.status === "ok" || inputs.ndma.status === "ok" || inputs.incois?.status === "ok";
  if (!hasOfficialCoverage) {
    missingData.push("official alert coverage");
  }

  if (weather?.thunderstormLikely) {
    blockingReasons.push("Thunderstorm conditions are present in the forecast window.");
  }

  const maxWindKph = weather?.maxWindKph ?? null;
  const maxGustKph = weather?.maxGustKph ?? null;
  const minVisibilityM = weather?.minVisibilityM ?? null;
  const maxWaveHeightM = marine?.maxWaveHeightM ?? null;
  const maxSwellHeightM = marine?.maxSwellHeightM ?? null;

  if (maxWindKph !== null && maxWindKph > policy.maxWindKph) {
    blockingReasons.push(`Forecast wind may exceed the configured ${policy.maxWindKph} km/h profile limit.`);
  } else if (maxWindKph !== null && maxWindKph > policy.maxWindKph * 0.8) {
    riskFactors.push("Forecast wind is close to the configured vessel profile limit.");
  }

  if (maxGustKph !== null && maxGustKph > policy.maxGustKph) {
    blockingReasons.push(`Forecast gusts may exceed the configured ${policy.maxGustKph} km/h profile limit.`);
  } else if (maxGustKph !== null && maxGustKph > policy.maxGustKph * 0.8) {
    riskFactors.push("Forecast gusts are close to the configured vessel profile limit.");
  }

  if (minVisibilityM !== null && minVisibilityM < policy.minVisibilityM) {
    riskFactors.push("Reduced visibility is present in the forecast window.");
  }

  if (inputs.context.waterMode === "marine" && maxWaveHeightM !== null && policy.maxWaveHeightM !== undefined) {
    if (maxWaveHeightM > policy.maxWaveHeightM) blockingReasons.push("Wave height may exceed the configured vessel profile limit.");
    else if (maxWaveHeightM > policy.maxWaveHeightM * 0.8) riskFactors.push("Wave height is close to the configured vessel profile limit.");
  }

  if (inputs.context.waterMode === "marine" && maxSwellHeightM !== null && policy.maxSwellHeightM !== undefined) {
    if (maxSwellHeightM > policy.maxSwellHeightM) blockingReasons.push("Swell height may exceed the configured vessel profile limit.");
    else if (maxSwellHeightM > policy.maxSwellHeightM * 0.8) riskFactors.push("Swell height is close to the configured vessel profile limit.");
  }

  const restrictionsData = inputs.restrictions?.data;
  if (restrictionsData && /closed|ban|prohibited|no.?fishing/i.test(JSON.stringify(restrictionsData))) {
    blockingReasons.push("The configured restrictions API reports a possible fishing restriction.");
  }

  let decision: FishingAssessment["decision"] = "GO";
  if (blockingReasons.length) decision = "NO_GO";
  else if (missingData.length) decision = "UNKNOWN";
  else if (riskFactors.length) decision = "CAUTION";

  if (process.env.SAFETY_POLICY_APPROVED !== "true" && decision === "GO") {
    decision = "UNKNOWN";
    missingData.push("expert-approved safety policy");
  }

  const sources = [
    ...inputs.weather.evidence,
    ...(inputs.marine?.evidence ?? []),
    ...inputs.imd.evidence,
    ...inputs.ndma.evidence,
    ...(inputs.incois?.evidence ?? []),
    ...(inputs.restrictions?.evidence ?? []),
  ];
  const detail = decision === "NO_GO"
    ? unique(blockingReasons).join(" ")
    : decision === "UNKNOWN"
      ? `I cannot verify this fishing window yet. Missing: ${unique(missingData).join(", ")}.`
      : decision === "CAUTION"
        ? unique(riskFactors).join(" ")
        : "The available conditions are within the configured profile for this fishing window.";

  const assessment = {
    decision,
    state: resultState(decision),
    title: titleFor(decision),
    detail,
    confidence: decision === "UNKNOWN" ? "low" : blockingReasons.length ? "high" : riskFactors.length ? "medium" : "medium",
    waterMode: inputs.context.waterMode,
    locationLabel: inputs.location.label,
    validFrom: now.toISOString(),
    validUntil: futureIso(now, 6),
    safeWindows: decision === "GO" ? [{ from: inputs.context.departureAt ?? now.toISOString(), until: inputs.context.returnAt ?? futureIso(now, 6) }] : [],
    metrics: { maxWindKph, maxGustKph, maxWaveHeightM, maxSwellHeightM, minVisibilityM },
    blockingReasons: unique(blockingReasons),
    riskFactors: unique(riskFactors),
    missingData: unique(missingData),
    officialAlerts: alerts,
    sources,
    policyVersion: POLICY_VERSION,
    generatedAt: now.toISOString(),
  } satisfies FishingAssessment;

  return FishingAssessmentSchema.parse(assessment);
}
