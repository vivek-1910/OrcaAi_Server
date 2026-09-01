import { FisherContextSchema, type FishingAssessment, type FishingAssessmentInput, type FisherContext, type FisherLocation, type IncoisSnapshot, type MarineData, type OfficialSnapshot, type ProviderResult, type ResolvedLocation, type WeatherData } from "../types/fishing.js";
import { evaluateFishingSafety } from "./safety-engine.js";
import { getImdSnapshot } from "../tool-providers/imd-client.js";
import { getIncoisSnapshot } from "../tool-providers/incois-client.js";
import { getNdmaSnapshot } from "../tool-providers/ndma-client.js";
import { getFishingRestrictions } from "../tool-providers/fishing-restrictions-client.js";
import { getMarine, getWeather, locationCoordinates, resolveLocation } from "../tool-providers/open-meteo-client.js";
import { unavailable } from "../tool-providers/http.js";

function locationForContext(context: FisherContext, resolved?: ResolvedLocation): FisherLocation {
  return {
    source: context.location.source,
    label: resolved?.label || context.location.label,
    latitude: resolved?.latitude ?? context.location.latitude,
    longitude: resolved?.longitude ?? context.location.longitude,
  };
}

function present(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined && Number.isFinite(value));
}

function windowBounds(context: FisherContext, now: Date): { start: number; end: number } {
  const start = context.departureAt ? Date.parse(context.departureAt) : now.getTime();
  const requestedEnd = context.returnAt ? Date.parse(context.returnAt) : start + 6 * 60 * 60 * 1000;
  const safeStart = Number.isFinite(start) ? start : now.getTime();
  const safeEnd = Number.isFinite(requestedEnd) && requestedEnd > safeStart ? requestedEnd : safeStart + 6 * 60 * 60 * 1000;
  return { start: safeStart, end: safeEnd };
}

function inWindow(time: string, bounds: { start: number; end: number }): boolean {
  const timestamp = Date.parse(time);
  return Number.isFinite(timestamp) && timestamp >= bounds.start && timestamp <= bounds.end;
}

function windowWeather(result: ProviderResult<WeatherData>, bounds: { start: number; end: number }): ProviderResult<WeatherData> {
  if (!result.data) return result;
  const hourly = result.data.hourly.filter((entry) => inWindow(entry.time, bounds));
  const wind = present(hourly.map((entry) => entry.windKph));
  const gusts = present(hourly.map((entry) => entry.gustKph));
  const precipitation = present(hourly.map((entry) => entry.precipitationMm));
  const precipitationProbability = present(hourly.map((entry) => entry.precipitationProbability));
  const visibility = present(hourly.map((entry) => entry.visibilityM));
  const codes = hourly.map((entry) => entry.weatherCode).filter((value): value is number => value !== undefined);

  return {
    ...result,
    data: {
      ...result.data,
      hourly,
      maxWindKph: wind.length ? Math.max(...wind) : undefined,
      maxGustKph: gusts.length ? Math.max(...gusts) : undefined,
      maxPrecipitationMm: precipitation.length ? Math.max(...precipitation) : undefined,
      maxPrecipitationProbability: precipitationProbability.length ? Math.max(...precipitationProbability) : undefined,
      minVisibilityM: visibility.length ? Math.min(...visibility) : undefined,
      thunderstormLikely: codes.some((code) => code >= 95),
    },
  };
}

function windowMarine(result: ProviderResult<MarineData> | undefined, bounds: { start: number; end: number }): ProviderResult<MarineData> | undefined {
  if (!result?.data) return result;
  const hourly = result.data.hourly.filter((entry) => inWindow(entry.time, bounds));
  const waves = present(hourly.map((entry) => entry.waveHeightM));
  const swells = present(hourly.map((entry) => entry.swellHeightM));
  const currents = present(hourly.map((entry) => entry.currentKph));
  return {
    ...result,
    data: {
      ...result.data,
      hourly,
      maxWaveHeightM: waves.length ? Math.max(...waves) : undefined,
      maxSwellHeightM: swells.length ? Math.max(...swells) : undefined,
      maxCurrentKph: currents.length ? Math.max(...currents) : undefined,
    },
  };
}

async function resolveContextLocation(context: FisherContext): Promise<{ location?: ResolvedLocation; result?: ProviderResult<ResolvedLocation> }> {
  const coordinates = locationCoordinates(context.location);
  if (coordinates) return { location: coordinates };
  if (context.location.source === "manual" && context.location.label.trim()) {
    const result = await resolveLocation(context.location.label);
    return { location: result.data, result };
  }
  return {};
}

export async function assessFishingTrip(
  rawContext: unknown,
  input: FishingAssessmentInput = {},
): Promise<FishingAssessment> {
  const parsed = FisherContextSchema.parse(rawContext);
  const context: FisherContext = {
    ...parsed,
    departureAt: input.departureAt ?? parsed.departureAt,
    returnAt: input.returnAt ?? parsed.returnAt,
    distanceKm: input.distanceKm ?? parsed.distanceKm,
  };
  const resolved = await resolveContextLocation(context);

  if (!resolved.location) {
    const missing = unavailable("Location", "A current location or named harbour/waterbody is required.");
    const weather = unavailable<WeatherData>("Open-Meteo Weather", "Location coordinates are unavailable.");
    const imd = unavailable<OfficialSnapshot>("India Meteorological Department", "Location coordinates are unavailable.");
    const ndma = unavailable<OfficialSnapshot>("NDMA SACHET", "Location coordinates are unavailable.");
    return evaluateFishingSafety({
      context,
      location: { label: context.location.label || "Unknown fishing location", latitude: 0, longitude: 0 },
      weather,
      marine: context.waterMode === "marine" ? unavailable("Open-Meteo Marine", "Location coordinates are unavailable.") : undefined,
      imd,
      ndma,
      incois: context.waterMode === "marine" ? unavailable<IncoisSnapshot>("INCOIS", "Location coordinates are unavailable.") : undefined,
      restrictions: missing,
    });
  }

  const location = resolved.location;
  const fisherLocation = locationForContext(context, location);
  const bounds = windowBounds(context, new Date());
  const weatherPromise = getWeather(location);
  const imdPromise = getImdSnapshot(fisherLocation, context.waterMode);
  const ndmaPromise = getNdmaSnapshot(fisherLocation);
  const marinePromise = context.waterMode === "marine" ? getMarine(location) : Promise.resolve(undefined);
  const incoisPromise = context.waterMode === "marine" ? getIncoisSnapshot(fisherLocation) : Promise.resolve(undefined);
  const restrictionsPromise = getFishingRestrictions(location.latitude, location.longitude, context.waterMode);
  const [weatherResult, imd, ndma, marineResult, incois, restrictions] = await Promise.all([
    weatherPromise,
    imdPromise,
    ndmaPromise,
    marinePromise,
    incoisPromise,
    restrictionsPromise,
  ]);
  const weather = windowWeather(weatherResult, bounds);
  const marine = windowMarine(marineResult, bounds);

  const result = evaluateFishingSafety({
    context,
    location,
    weather,
    marine,
    imd,
    ndma,
    incois,
    restrictions,
  });

  if (resolved.result) {
    result.sources.unshift(...resolved.result.evidence);
  }

  return result;
}
