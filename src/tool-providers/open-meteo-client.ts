import type {
  FisherLocation,
  HourlyMarine,
  HourlyWeather,
  MarineData,
  ProviderResult,
  ResolvedLocation,
  WeatherData,
} from "../types/fishing.js";
import { configured, fetchJson, unavailable } from "./http.js";

const WEATHER_PROVIDER = "Open-Meteo Weather";
const MARINE_PROVIDER = "Open-Meteo Marine";

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toNumberArray(value: unknown): Array<number | undefined> {
  return Array.isArray(value) ? value.map(toNumber) : [];
}

function utcTimestamp(value: string): string {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value;
  return value.length === 16 ? `${value}:00Z` : `${value}Z`;
}

function max(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.max(...present) : undefined;
}

function min(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length ? Math.min(...present) : undefined;
}

export async function resolveLocation(label: string): Promise<ProviderResult<ResolvedLocation>> {
  if (!label.trim()) {
    return unavailable("Open-Meteo Geocoding", "A harbour or waterbody is required.");
  }

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", label.trim());
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  try {
    const body = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url.toString());
    const first = body.results?.[0];
    const latitude = toNumber(first?.latitude);
    const longitude = toNumber(first?.longitude);

    if (!first || latitude === undefined || longitude === undefined) {
      return unavailable("Open-Meteo Geocoding", `No coordinates found for ${label.trim()}.`);
    }

    const resolved: ResolvedLocation = {
      label: String(first.name ?? label.trim()),
      latitude,
      longitude,
      country: typeof first.country === "string" ? first.country : undefined,
      admin1: typeof first.admin1 === "string" ? first.admin1 : undefined,
      admin2: typeof first.admin2 === "string" ? first.admin2 : undefined,
    };

    return {
      provider: "Open-Meteo Geocoding",
      status: "ok",
      data: resolved,
      warnings: [],
      evidence: [{
        provider: "Open-Meteo Geocoding",
        title: `Location lookup for ${resolved.label}`,
        url: url.toString(),
        fetchedAt: new Date().toISOString(),
        status: "ok",
        stale: false,
      }],
    };
  } catch (error) {
    return {
      provider: "Open-Meteo Geocoding",
      status: "error",
      warnings: [error instanceof Error ? error.message : "Location lookup failed."],
      evidence: [],
      error: error instanceof Error ? error.message : "Location lookup failed.",
    };
  }
}

export function locationCoordinates(location: FisherLocation): ResolvedLocation | undefined {
  if (location.latitude === undefined || location.longitude === undefined) {
    return undefined;
  }

  return {
    label: location.label || "Selected fishing location",
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

export async function getWeather(
  location: ResolvedLocation,
): Promise<ProviderResult<WeatherData>> {
  const base = process.env.OPEN_METEO_BASE_URL?.trim() || "https://api.open-meteo.com";
  const url = new URL("/v1/forecast", base);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("current", "temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,visibility");
  url.searchParams.set("hourly", "temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,visibility");
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("timezone", "UTC");

  try {
    const body = await fetchJson<Record<string, unknown>>(url.toString());
    const hourly = (body.hourly ?? {}) as Record<string, unknown>;
    const times = toStringArray(hourly.time);
    const temperatures = toNumberArray(hourly.temperature_2m);
    const precipitation = toNumberArray(hourly.precipitation);
    const precipitationProbability = toNumberArray(hourly.precipitation_probability);
    const weatherCodes = toNumberArray(hourly.weather_code);
    const wind = toNumberArray(hourly.wind_speed_10m);
    const gusts = toNumberArray(hourly.wind_gusts_10m);
    const visibility = toNumberArray(hourly.visibility);
    const hourlyData: HourlyWeather[] = times.map((time, index) => ({
      time: utcTimestamp(time),
      temperatureC: temperatures[index],
      precipitationMm: precipitation[index],
      precipitationProbability: precipitationProbability[index],
      weatherCode: weatherCodes[index],
      windKph: wind[index],
      gustKph: gusts[index],
      visibilityM: visibility[index],
    }));

    const currentBody = (body.current ?? {}) as Record<string, unknown>;
    const current: HourlyWeather | undefined = typeof currentBody.time === "string"
      ? {
          time: utcTimestamp(currentBody.time),
          temperatureC: toNumber(currentBody.temperature_2m),
          precipitationMm: toNumber(currentBody.precipitation),
          weatherCode: toNumber(currentBody.weather_code),
          windKph: toNumber(currentBody.wind_speed_10m),
          gustKph: toNumber(currentBody.wind_gusts_10m),
          visibilityM: toNumber(currentBody.visibility),
        }
      : undefined;

    const codes = hourlyData.map((entry) => entry.weatherCode);
    const data: WeatherData = {
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      current,
      hourly: hourlyData,
      maxWindKph: max(hourlyData.map((entry) => entry.windKph)),
      maxGustKph: max(hourlyData.map((entry) => entry.gustKph)),
      maxPrecipitationMm: max(hourlyData.map((entry) => entry.precipitationMm)),
      maxPrecipitationProbability: max(hourlyData.map((entry) => entry.precipitationProbability)),
      minVisibilityM: min(hourlyData.map((entry) => entry.visibilityM)),
      thunderstormLikely: codes.some((code) => code !== undefined && code >= 95),
    };

    return {
      provider: WEATHER_PROVIDER,
      status: "ok",
      data,
      warnings: [],
      evidence: [{
        provider: WEATHER_PROVIDER,
        title: `Hourly forecast near ${location.label}`,
        url: url.toString(),
        fetchedAt: new Date().toISOString(),
        status: "ok",
        stale: false,
      }],
    };
  } catch (error) {
    return {
      provider: WEATHER_PROVIDER,
      status: "error",
      warnings: [error instanceof Error ? error.message : "Weather lookup failed."],
      evidence: [],
      error: error instanceof Error ? error.message : "Weather lookup failed.",
    };
  }
}

export async function getMarine(
  location: ResolvedLocation,
): Promise<ProviderResult<MarineData>> {
  const base = process.env.OPEN_METEO_MARINE_BASE_URL?.trim() || "https://marine-api.open-meteo.com";
  const url = new URL("/v1/marine", base);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("hourly", "wave_height,wave_period,swell_wave_height,swell_wave_period,ocean_current_velocity,sea_surface_temperature,sea_level_height_msl");
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("timezone", "UTC");

  try {
    const body = await fetchJson<Record<string, unknown>>(url.toString());
    const hourly = (body.hourly ?? {}) as Record<string, unknown>;
    const times = toStringArray(hourly.time);
    const waves = toNumberArray(hourly.wave_height);
    const periods = toNumberArray(hourly.wave_period);
    const swells = toNumberArray(hourly.swell_wave_height);
    const swellPeriods = toNumberArray(hourly.swell_wave_period);
    const currents = toNumberArray(hourly.ocean_current_velocity);
    const temperatures = toNumberArray(hourly.sea_surface_temperature);
    const seaLevels = toNumberArray(hourly.sea_level_height_msl);
    const hourlyData: HourlyMarine[] = times.map((time, index) => ({
      time: utcTimestamp(time),
      waveHeightM: waves[index],
      wavePeriodS: periods[index],
      swellHeightM: swells[index],
      swellPeriodS: swellPeriods[index],
      currentKph: currents[index],
      seaSurfaceTemperatureC: temperatures[index],
      seaLevelHeightM: seaLevels[index],
    }));

    const data: MarineData = {
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      hourly: hourlyData,
      maxWaveHeightM: max(hourlyData.map((entry) => entry.waveHeightM)),
      maxSwellHeightM: max(hourlyData.map((entry) => entry.swellHeightM)),
      maxCurrentKph: max(hourlyData.map((entry) => entry.currentKph)),
    };

    return {
      provider: MARINE_PROVIDER,
      status: "ok",
      data,
      warnings: ["Open-Meteo marine tide/current estimates are not a navigation substitute."],
      evidence: [{
        provider: MARINE_PROVIDER,
        title: `Marine forecast near ${location.label}`,
        url: url.toString(),
        fetchedAt: new Date().toISOString(),
        status: "ok",
        stale: false,
      }],
    };
  } catch (error) {
    return {
      provider: MARINE_PROVIDER,
      status: "error",
      warnings: [error instanceof Error ? error.message : "Marine lookup failed."],
      evidence: [],
      error: error instanceof Error ? error.message : "Marine lookup failed.",
    };
  }
}

export function openMeteoConfigured(): boolean {
  return configured(process.env.OPEN_METEO_BASE_URL) || configured(process.env.OPEN_METEO_MARINE_BASE_URL);
}
