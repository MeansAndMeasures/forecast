import { z } from "zod";
import { Source, SourceContext, boundsFrom } from "./types";

const MetarCloudLayerSchema = z.object({
  cover: z.string(),
  base: z.number().nullish(),
});

const MetarObservationSchema = z.object({
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
  wg: z.number().nullish(),
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
});

const MetarResponseSchema = z.array(MetarObservationSchema);

export type MetarObservation = z.infer<typeof MetarObservationSchema>;

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
