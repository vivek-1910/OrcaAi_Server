import assert from "node:assert/strict";
import test from "node:test";
import type {
  FisherContext,
  MarineData,
  OfficialSnapshot,
  ProviderResult,
  ResolvedLocation,
  WeatherData,
} from "../types/fishing.js";
import { evaluateFishingSafety } from "./safety-engine.js";

const context: FisherContext = {
  waterMode: "marine",
  location: { source: "permission", label: "Test harbour", latitude: 12, longitude: 74 },
  language: "English",
  vessel: { type: "Small boat", name: "Test boat", lengthFeet: "18" },
  experience: "regular",
  tripTiming: "early-morning",
};

const location: ResolvedLocation = { label: "Test harbour", latitude: 12, longitude: 74 };

function result<T>(provider: string, data: T): ProviderResult<T> {
  return {
    provider,
    status: "ok",
    data,
    warnings: [],
    evidence: [{ provider, title: provider, fetchedAt: "2026-09-02T00:00:00.000Z", status: "ok", stale: false }],
  };
}

const weather: WeatherData = {
  hourly: [],
  maxWindKph: 12,
  maxGustKph: 18,
  maxPrecipitationMm: 0,
  maxPrecipitationProbability: 10,
  minVisibilityM: 10000,
  thunderstormLikely: false,
};

const marine: MarineData = {
  hourly: [],
  maxWaveHeightM: 0.4,
  maxSwellHeightM: 0.3,
  maxCurrentKph: 1,
};

const clearOfficial: OfficialSnapshot = { alerts: [], hasBlockingAlert: false, records: [] };

function inputs(overrides: Partial<Parameters<typeof evaluateFishingSafety>[0]> = {}) {
  return {
    context,
    location,
    weather: result("Open-Meteo Weather", weather),
    marine: result("Open-Meteo Marine", marine),
    imd: result("IMD", clearOfficial),
    ndma: result("NDMA", clearOfficial),
    incois: result("INCOIS", clearOfficial),
    ...overrides,
  };
}

test("fails closed when the prototype policy is not approved", () => {
  const previous = process.env.SAFETY_POLICY_APPROVED;
  delete process.env.SAFETY_POLICY_APPROVED;
  const assessment = evaluateFishingSafety(inputs());
  assert.equal(assessment.decision, "UNKNOWN");
  assert.match(assessment.missingData.join(" "), /expert-approved safety policy/);
  if (previous === undefined) delete process.env.SAFETY_POLICY_APPROVED;
  else process.env.SAFETY_POLICY_APPROVED = previous;
});

test("official blocking alerts always produce NO_GO", () => {
  const assessment = evaluateFishingSafety(inputs({
    imd: result("IMD", {
      alerts: [{ title: "Cyclone warning", event: "Cyclone", relevant: true, blocking: true }],
      hasBlockingAlert: true,
      records: [],
    }),
  }));
  assert.equal(assessment.decision, "NO_GO");
  assert.equal(assessment.state, "avoid");
});

test("structured forecast remains usable as CAUTION when official feeds are down", () => {
  const previous = process.env.SAFETY_POLICY_APPROVED;
  process.env.SAFETY_POLICY_APPROVED = "true";
  const unavailableOfficial = (provider: string): ProviderResult<OfficialSnapshot> => ({
    provider,
    status: "unavailable",
    evidence: [],
    warnings: ["temporary outage"],
    error: "temporary outage",
  });

  const assessment = evaluateFishingSafety(inputs({
    imd: unavailableOfficial("IMD"),
    ndma: unavailableOfficial("NDMA"),
    incois: unavailableOfficial("INCOIS"),
  }));

  assert.equal(assessment.decision, "CAUTION");
  assert.match(assessment.detail, /official alert feeds are unavailable/i);
  if (previous === undefined) delete process.env.SAFETY_POLICY_APPROVED;
  else process.env.SAFETY_POLICY_APPROVED = previous;
});

test("approved clear conditions produce GO", () => {
  const previous = process.env.SAFETY_POLICY_APPROVED;
  process.env.SAFETY_POLICY_APPROVED = "true";
  const assessment = evaluateFishingSafety(inputs());
  assert.equal(assessment.decision, "GO");
  assert.equal(assessment.state, "go");
  if (previous === undefined) delete process.env.SAFETY_POLICY_APPROVED;
  else process.env.SAFETY_POLICY_APPROVED = previous;
});

test("missing marine data produces UNKNOWN instead of GO", () => {
  const assessment = evaluateFishingSafety(inputs({ marine: { provider: "Open-Meteo Marine", status: "unavailable", warnings: ["missing"], evidence: [] } }));
  assert.equal(assessment.decision, "UNKNOWN");
  assert.match(assessment.missingData.join(" "), /marine wave and swell/);
});

test("wind above the vessel profile produces NO_GO", () => {
  const assessment = evaluateFishingSafety(inputs({
    weather: result("Open-Meteo Weather", { ...weather, maxWindKph: 50 }),
  }));
  assert.equal(assessment.decision, "NO_GO");
  assert.match(assessment.blockingReasons.join(" "), /wind/);
});
