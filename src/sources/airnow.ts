import { z } from "zod";
import { Source, SourceContext, boundsFrom } from "./types";

/**
 * AirNow retired `/aq/observation/latLong/current/` on 2026-10-01 (it now
 * answers 410). Its replacement is `/aq/observation/current/ziplatlong/`, which
 * takes the same latitude/longitude and key, ignores `distance` (it picks the
 * nearest reporting area itself), and answers in camelCase.
 *
 * Snapshots keep each row exactly as AirNow sent it (docs/sources.md: no
 * renaming of upstream fields). Older snapshots hold the retired service's
 * PascalCase rows, newer ones the camelCase rows, so everything downstream
 * reads AirNow through `readAirNow`, which understands both.
 */

const str = z.string().nullish();
const num = z.union([z.number(), z.string()]).nullish();

/** Upstream row, legacy or current naming. Unknown fields pass through untouched. */
const UpstreamRowSchema = z
  .object({
    dateObserved: str,
    DateObserved: str,
    hourObserved: num,
    HourObserved: num,
    localTimeZone: str,
    LocalTimeZone: str,
    reportingAreaName: str,
    ReportingArea: str,
    siteName: str,
    stateCode: str,
    StateCode: str,
    latitude: num,
    Latitude: num,
    longitude: num,
    Longitude: num,
    parameterName: str,
    ParameterName: str,
    nowcastAQI: num,
    aqi: num,
    AQI: num,
    aqiCategoryName: str,
    aqiCategoryNumber: num,
    Category: z.object({ Number: num, Name: str }).nullish(),
  })
  .passthrough();

export type AirNowObservation = z.infer<typeof UpstreamRowSchema>;

/** A row is usable when it names a date, an hour, a pollutant and an AQI field. */
const AirNowObservationSchema = UpstreamRowSchema.refine(
  (r) =>
    Boolean(r.dateObserved ?? r.DateObserved) &&
    (r.hourObserved ?? r.HourObserved) !== undefined &&
    Boolean(r.parameterName ?? r.ParameterName) &&
    (r.nowcastAQI ?? r.AQI ?? r.aqi) !== undefined,
  { message: "AirNow row lacks date, hour, parameter or AQI" },
);

const AirNowResponseSchema = z.array(AirNowObservationSchema);

/** One AirNow row as the pipeline reads it, whichever service produced it. */
export type AirNowReading = {
  /** YYYY-MM-DD, when the row carries a date. */
  date?: string;
  hour?: number;
  timeZone?: string;
  area: string;
  state?: string;
  site?: string;
  /** "O3", "PM2.5" or "PM10" (the current service spells ozone out); "" if unnamed. */
  parameter: string;
  aqi: number;
  category: { Number: number; Name: string };
};

const CATEGORY_NUMBERS: Record<string, number> = {
  good: 1,
  moderate: 2,
  "unhealthy for sensitive groups": 3,
  unhealthy: 4,
  "very unhealthy": 5,
  hazardous: 6,
};

/** AirNow's AQI breakpoints, used only when a row carries no category. */
function categoryForAqi(aqi: number): { Number: number; Name: string } {
  if (aqi <= 50) return { Number: 1, Name: "Good" };
  if (aqi <= 100) return { Number: 2, Name: "Moderate" };
  if (aqi <= 150) return { Number: 3, Name: "Unhealthy for Sensitive Groups" };
  if (aqi <= 200) return { Number: 4, Name: "Unhealthy" };
  if (aqi <= 300) return { Number: 5, Name: "Very Unhealthy" };
  return { Number: 6, Name: "Hazardous" };
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** "14", 14, "14:00" and "14:30" all read as hour 14. */
function toHour(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v < 24 ? v : undefined;
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2})(?::\d{2})?$/);
    if (!m) return undefined;
    const h = Number(m[1]);
    return h >= 0 && h < 24 ? h : undefined;
  }
  return undefined;
}

/** "2026-11-26", "2026-11-26 " and "11/26/2026" all read as 2026-11-26. */
function toIsoDate(v: string): string | undefined {
  const t = v.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return undefined;
}

/** The current service spells ozone out; the latents match the legacy "O3". */
function canonicalParameter(name: string): string {
  const n = name.trim();
  if (/^ozone$/i.test(n)) return "O3";
  if (/^pm\s*2\.?5$/i.test(n)) return "PM2.5";
  if (/^pm\s*10$/i.test(n)) return "PM10";
  return n;
}

/** Read one stored or fetched AirNow row; undefined if it carries no AQI value. */
export function readAirNow(raw: unknown): AirNowReading | undefined {
  const parsed = UpstreamRowSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const row = parsed.data;
  const aqi = toNumber(row.nowcastAQI ?? row.AQI ?? row.aqi);
  const rawDate = row.dateObserved ?? row.DateObserved;
  const date = rawDate ? toIsoDate(rawDate) : undefined;
  const hour = toHour(row.hourObserved ?? row.HourObserved);
  const parameter = row.parameterName ?? row.ParameterName;
  // AirNow uses -1 for "no value". Only the value itself is required to read a
  // row; parseAirNowBody is where a fetched row must be complete.
  if (aqi === undefined || aqi < 0) return undefined;

  const categoryName = (row.aqiCategoryName ?? row.Category?.Name)?.trim();
  const categoryNumber =
    toNumber(row.aqiCategoryNumber ?? row.Category?.Number) ??
    (categoryName ? CATEGORY_NUMBERS[categoryName.toLowerCase()] : undefined);
  const reading: AirNowReading = {
    area: (row.reportingAreaName ?? row.ReportingArea ?? row.siteName ?? "").trim(),
    parameter: parameter ? canonicalParameter(parameter) : "",
    aqi,
    category: categoryName && categoryNumber !== undefined ? { Number: categoryNumber, Name: categoryName } : categoryForAqi(aqi),
  };
  if (date) reading.date = date;
  if (hour !== undefined) reading.hour = hour;
  const tz = (row.localTimeZone ?? row.LocalTimeZone)?.trim();
  if (tz) reading.timeZone = tz;
  const state = (row.stateCode ?? row.StateCode)?.trim();
  if (state) reading.state = state;
  if (row.siteName) reading.site = row.siteName.trim();
  return reading;
}

/** Readings from a snapshot's rows, skipping rows without a value. */
export function airnowReadings(rows: unknown[]): AirNowReading[] {
  return rows.map(readAirNow).filter((r): r is AirNowReading => r !== undefined);
}

/**
 * Parse an AirNow body. AirNow answers "nothing here" with HTTP 200 and a
 * `{"WebServiceError":[{"Message":…}]}` envelope; a retirement notice comes in
 * the same envelope, so that one is still an error.
 */
export function parseAirNowBody(raw: unknown): AirNowObservation[] {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "WebServiceError" in raw) {
    const errs = (raw as { WebServiceError?: Array<{ Message?: string }> }).WebServiceError ?? [];
    const message = errs.map((e) => e?.Message ?? "").join(" ").trim();
    if (/retired|invalid|key|unauthori[sz]ed|forbidden|limit/i.test(message)) {
      throw new Error(`AirNow error: ${message.slice(0, 200)}`);
    }
    return [];
  }
  const parsed = AirNowResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`AirNow payload not recognized: ${JSON.stringify(parsed.error.format()).slice(0, 500)}`);
  }
  return parsed.data;
}

export function airnowUrl(lat: number, lon: number, key: string): string {
  const params = new URLSearchParams({
    format: "application/json",
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    API_KEY: key,
  });
  return `https://www.airnowapi.org/aq/observation/current/ziplatlong/?${params.toString()}`;
}

function epochSeconds(o: AirNowObservation): number {
  const r = readAirNow(o);
  if (!r?.date || r.hour === undefined) return Math.floor(Date.now() / 1000);
  const d = new Date(`${r.date}T${String(r.hour).padStart(2, "0")}:00:00`);
  return Math.floor(d.getTime() / 1000);
}

export const airnowSource: Source<AirNowObservation> = {
  name: "AIRNOW",
  cadenceMs: 5 * 60 * 1000,
  schema: AirNowResponseSchema,
  isEnabled(ctx: SourceContext) {
    return Boolean(ctx.env.AIRNOW_API_KEY);
  },
  async fetch(ctx: SourceContext) {
    const res = await fetch(airnowUrl(ctx.lat, ctx.lon, ctx.env.AIRNOW_API_KEY!));
    if (!res.ok) {
      // Never echo the URL: it carries the API key.
      throw new Error(`AirNow fetch failed: ${res.status} ${res.statusText}`);
    }
    return parseAirNowBody(await res.json());
  },
  observedAt(data) {
    return boundsFrom(data, epochSeconds);
  },
};
