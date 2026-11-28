import { z } from "zod";
import { Source, SourceContext, boundsFrom } from "./types";

const MetarCloudLayerSchema = z.object({
  cover: z.string(),
  base: z.number().nullish(),
});

/**
 * Fields AWC sends beyond these (pressure tendency, max/min temperature,
 * precipitation groups) pass through into the snapshot untouched, so a field
 * is never lost just because nothing reads it yet.
 */
const MetarObservationSchema = z
  .object({
    icaoId: z.string(),
    receiptTime: z.string(),
    obsTime: z.number(),
    reportTime: z.string(),
    // AWC omits or nulls a field when the station did not report it, and sends
    // "VRB" for variable wind direction. One missing sensor must not drop the
    // whole field, so everything a station can leave out is optional.
    temp: z.number().nullish(),
    dewp: z.number().nullish(),
    wdir: z.union([z.number(), z.string()]).nullish(),
    wspd: z.number().nullish(),
    // Gusts: AWC's JSON has used both names; gustKt() reads either, then the raw report.
    wg: z.number().nullish(),
    wgst: z.number().nullish(),
    visib: z.union([z.number(), z.string()]).nullish(),
    altim: z.number().nullish(),
    slp: z.number().nullish(),
    qcField: z.number().nullish(),
    metarType: z.string(),
    rawOb: z.string(),
    lat: z.number(),
    lon: z.number(),
    elev: z.number().nullish(),
    name: z.string().nullish(),
    cover: z.string().nullish(),
    clouds: z.array(MetarCloudLayerSchema).nullish(),
    wxString: z.string().nullish(),
    fltCat: z.string().nullish(),
  })
  .passthrough();

const MetarResponseSchema = z.array(MetarObservationSchema);

export type MetarObservation = z.infer<typeof MetarObservationSchema>;

/** Peak gust in knots from a "dddssGggKT" or "VRBssGggKT" wind group. */
const RAW_GUST = /\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/;

/**
 * A station's reported gust in knots, or undefined when it reported none.
 * Reads the decoded field under either name AWC has used, then falls back to
 * the wind group in the raw report, which always carries a gust when there is
 * one.
 */
export function gustKt(row: unknown): number | undefined {
  const r = row as { wgst?: unknown; wg?: unknown; rawOb?: unknown };
  for (const v of [r.wgst, r.wg]) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  if (typeof r.rawOb === "string") {
    const m = r.rawOb.match(RAW_GUST);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Visibility in statute miles, or undefined when the station did not report
 * it. AWC sends a number, or a string such as "10+" (ten miles or more) or a
 * fraction such as "1/2" or "1 1/2"; "10+" reads as 10, its lower bound.
 * A leading "P" or "M" (more or less than) reads as the stated bound too.
 */
export function visibilitySm(row: unknown): number | undefined {
  const v = (row as { visib?: unknown }).visib;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/^[PM]/i, "").replace(/\+$/, "").replace(/\s*SM$/i, "").trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[2]) === 0 ? undefined : Number(frac[1]) / Number(frac[2]);
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

/**
 * Bounding box for the AWC Data API, as `south,west,north,east` rounded to four
 * decimals (about 11 m). The API answers 400 to long float tails, which is what
 * `radius / 69` produces unrounded.
 */
export function metarBbox(lat: number, lon: number, radiusMiles: number): string {
  const latDelta = radiusMiles / 69;
  const lonDelta = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180));
  return [lat - latDelta, lon - lonDelta, lat + latDelta, lon + lonDelta].map((n) => n.toFixed(4)).join(",");
}

/** AWC asks API clients to identify themselves with a User-Agent. */
export const METAR_USER_AGENT = "Means+Measures Forecast contact@meansandmeasures.com";

export const metarSource: Source<MetarObservation> = {
  name: "METAR",
  cadenceMs: 5 * 60 * 1000,
  schema: MetarResponseSchema,
  isEnabled() {
    return true;
  },
  async fetch(ctx: SourceContext) {
    const url = `https://aviationweather.gov/api/data/metar?bbox=${metarBbox(ctx.lat, ctx.lon, ctx.radiusMiles)}&format=json`;
    const res = await fetch(url, { headers: { "User-Agent": METAR_USER_AGENT, Accept: "application/json" } });
    // 204 is AWC's answer for "no stations reported in this box".
    if (res.status === 204) return [];
    if (!res.ok) {
      throw new Error(`METAR fetch failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.text();
    if (body.trim() === "") return [];
    const raw = JSON.parse(body);
    const parsed = MetarResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.format(), null, 2));
    }
    return parsed.data;
  },
  observedAt(data) {
    return boundsFrom(data, (o) => o.obsTime);
  },
};
