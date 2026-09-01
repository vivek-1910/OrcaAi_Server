import { z } from "zod";

export const WaterModeSchema = z.enum(["marine", "inland"]);
export type WaterMode = z.infer<typeof WaterModeSchema>;

export const LocationSourceSchema = z.enum(["permission", "manual", "unset"]);

export const FisherLocationSchema = z.object({
  source: LocationSourceSchema,
  label: z.string().trim().max(200).default(""),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type FisherLocation = z.infer<typeof FisherLocationSchema>;

export const VesselSchema = z.object({
  type: z.string().trim().max(100).default("Small boat"),
  name: z.string().trim().max(100).default(""),
  lengthFeet: z.union([z.string(), z.number()]).default(""),
});

export const FisherContextSchema = z.object({
  waterMode: WaterModeSchema.default("marine"),
  location: FisherLocationSchema,
  language: z.string().trim().max(40).default("English"),
  vessel: VesselSchema,
  experience: z.enum(["new", "learning", "regular", "expert"]).default("regular"),
  tripTiming: z
    .enum(["early-morning", "day", "evening", "overnight"])
    .default("early-morning"),
  departureAt: z.string().datetime({ offset: true }).optional(),
  returnAt: z.string().datetime({ offset: true }).optional(),
  distanceKm: z.number().min(0).max(1000).optional(),
});
export type FisherContext = z.infer<typeof FisherContextSchema>;

export const FishingAssessmentInputSchema = z.object({
  departureAt: z.string().datetime({ offset: true }).optional(),
  returnAt: z.string().datetime({ offset: true }).optional(),
  distanceKm: z.number().min(0).max(1000).optional(),
});
export type FishingAssessmentInput = z.infer<typeof FishingAssessmentInputSchema>;

export const ProviderStatusSchema = z.enum(["ok", "unavailable", "error"]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const SourceEvidenceSchema = z.object({
  provider: z.string(),
  title: z.string(),
  url: z.string().url().optional(),
  issuedAt: z.string().optional(),
  fetchedAt: z.string(),
  validUntil: z.string().optional(),
  status: ProviderStatusSchema,
  stale: z.boolean().default(false),
});
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;

export type ProviderResult<T> = {
  provider: string;
  status: ProviderStatus;
  data?: T;
  evidence: SourceEvidence[];
  warnings: string[];
  error?: string;
};

export type HourlyWeather = {
  time: string;
  temperatureC?: number;
  precipitationMm?: number;
  precipitationProbability?: number;
  weatherCode?: number;
  windKph?: number;
  gustKph?: number;
  visibilityM?: number;
};

export type WeatherData = {
  timezone?: string;
  current?: HourlyWeather;
  hourly: HourlyWeather[];
  maxWindKph?: number;
  maxGustKph?: number;
  maxPrecipitationMm?: number;
  maxPrecipitationProbability?: number;
  minVisibilityM?: number;
  thunderstormLikely: boolean;
};

export type HourlyMarine = {
  time: string;
  waveHeightM?: number;
  wavePeriodS?: number;
  swellHeightM?: number;
  swellPeriodS?: number;
  currentKph?: number;
  seaSurfaceTemperatureC?: number;
  seaLevelHeightM?: number;
};

export type MarineData = {
  timezone?: string;
  hourly: HourlyMarine[];
  maxWaveHeightM?: number;
  maxSwellHeightM?: number;
  maxCurrentKph?: number;
};

export type OfficialAlert = {
  title: string;
  description?: string;
  severity?: string;
  event?: string;
  area?: string;
  issuedAt?: string;
  expiresAt?: string;
  relevant: boolean;
  blocking: boolean;
};

export type OfficialSnapshot = {
  alerts: OfficialAlert[];
  hasBlockingAlert: boolean;
  records: unknown[];
};

export type IncoisSnapshot = {
  hasBlockingAlert: boolean;
  alerts: OfficialAlert[];
  records: unknown[];
};

export const FishingDecisionSchema = z.enum(["GO", "CAUTION", "NO_GO", "UNKNOWN"]);
export type FishingDecision = z.infer<typeof FishingDecisionSchema>;

export const FishingAssessmentSchema = z.object({
  decision: FishingDecisionSchema,
  state: z.enum(["go", "caution", "avoid", "wait"]),
  title: z.string(),
  detail: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  waterMode: WaterModeSchema,
  locationLabel: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  safeWindows: z.array(z.object({ from: z.string(), until: z.string() })),
  metrics: z.object({
    maxWindKph: z.number().nullable(),
    maxGustKph: z.number().nullable(),
    maxWaveHeightM: z.number().nullable(),
    maxSwellHeightM: z.number().nullable(),
    minVisibilityM: z.number().nullable(),
  }),
  blockingReasons: z.array(z.string()),
  riskFactors: z.array(z.string()),
  missingData: z.array(z.string()),
  officialAlerts: z.array(z.object({
    title: z.string(),
    description: z.string().optional(),
    severity: z.string().optional(),
    event: z.string().optional(),
    area: z.string().optional(),
    issuedAt: z.string().optional(),
    expiresAt: z.string().optional(),
    relevant: z.boolean(),
    blocking: z.boolean(),
  })),
  sources: z.array(SourceEvidenceSchema),
  policyVersion: z.string(),
  generatedAt: z.string(),
});
export type FishingAssessment = z.infer<typeof FishingAssessmentSchema>;

export type ResolvedLocation = {
  label: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  admin2?: string;
};

export type SkillId =
  | "fishing-safety"
  | "fishing-conditions"
  | "fishing-regulations"
  | "fishing-pfz"
  | "fishing-briefing"
  | "fishing-knowledge";

export type SkillManifest = {
  id: SkillId;
  version: string;
  title: string;
  description: string;
  waterModes: WaterMode[];
  triggers: string[];
  requiredContext: string[];
  allowedTools: string[];
  safetyClass: "decision" | "information" | "briefing";
};
