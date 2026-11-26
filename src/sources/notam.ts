import { z } from "zod";
import { NotamRecord, NotamRecordSchema, epochSeconds } from "../notam-schema";
import { Source, SourceContext } from "./types";

/**
 * NOTAM, polled from the FAA NOTAM Management Service (NMS) API.
 *
 * This replaces the need for an always-on SWIM JMS consumer: the cron tick asks
 * NMS for every NOTAM within the field's radius and writes the batch like any
 * other source. The SWIM relay in `relay/notam/` and POST /ingest/notam still
 * work and land in the same `NOTAM` snapshots, but nothing requires them.
 *
 * Access is not self-serve. The FAA issues an OAuth client id and secret on
 * request; until both are set this source reports itself disabled.
 *
 * Wire details follow the published NMS client conventions: OAuth2
 * client_credentials with HTTP Basic auth against `/v1/auth/token`, then
 * `GET {base}/v1/notams?latitude=&longitude=&radius=` with a bearer token and
 * `nmsResponseFormat: GEOJSON`. Radius is nautical miles, capped at 100.
 * Endpoints and field names should be checked against the documentation the
 * FAA sends with the credentials.
 */

export const NMS_PRODUCTION_BASE_URL = "https://api-nms.aim.faa.gov/nmsapi";
export const NMS_PRODUCTION_AUTH_URL = "https://api-nms.aim.faa.gov/v1/auth/token";
export const NMS_STAGING_BASE_URL = "https://api-staging.cgifederal-aim.com/nmsapi";
export const NMS_STAGING_AUTH_URL = "https://api-staging.cgifederal-aim.com/v1/auth/token";

const MAX_RADIUS_NM = 100;
const MILES_PER_NM = 1.150779;
const TOKEN_RENEW_BUFFER_MS = 60_000;
const DEFAULT_TOKEN_TTL_S = 1799;

const optStr = z.string().nullish();

const NmsNotamFieldsSchema = z
  .object({
    id: optStr,
    number: optStr,
    type: optStr,
    issued: optStr,
    location: optStr,
    icaoLocation: optStr,
    airportName: optStr,
    effectiveStart: optStr,
    effectiveEnd: optStr,
    text: optStr,
    classification: optStr,
    selectionCode: optStr,
    affectedFir: optStr,
    minimumFl: z.union([z.string(), z.number()]).nullish(),
    maximumFl: z.union([z.string(), z.number()]).nullish(),
    coordinates: optStr,
    radius: z.union([z.string(), z.number()]).nullish(),
    year: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const NmsFeatureSchema = z
  .object({
    geometry: z
      .object({ type: optStr, coordinates: z.unknown().optional() })
      .passthrough()
      .nullish(),
    properties: z
      .object({
        coreNOTAMData: z.object({ notam: NmsNotamFieldsSchema }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const NmsResponseSchema = z
  .object({
    data: z.object({ geojson: z.array(NmsFeatureSchema).default([]) }).passthrough().default({ geojson: [] }),
  })
  .passthrough();

type NmsFeature = z.infer<typeof NmsFeatureSchema>;

export type NmsConfig = {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  authUrl: string;
};

/** Credentials and endpoints from env; undefined until both credentials are set. */
export function nmsConfig(env: Record<string, string | undefined>): NmsConfig | undefined {
  const clientId = env.FAA_NMS_CLIENT_ID?.trim();
  const clientSecret = env.FAA_NMS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return {
    clientId,
    clientSecret,
    baseUrl: (env.FAA_NMS_BASE_URL?.trim() || NMS_PRODUCTION_BASE_URL).replace(/\/+$/, ""),
    authUrl: env.FAA_NMS_AUTH_URL?.trim() || NMS_PRODUCTION_AUTH_URL,
  };
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A date NMS may send as "PERM" or an estimate marker; keep only real instants. */
function isoOrUndefined(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** First [lon, lat] position of a GeoJSON point or polygon. */
function firstPosition(geometry: NmsFeature["geometry"]): { lat: number; lon: number } | undefined {
  let c: unknown = geometry?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
    return { lon: c[0], lat: c[1] };
  }
  return undefined;
}

/** Map one NMS GeoJSON feature to the canonical record, or undefined if it lacks the essentials. */
export function nmsFeatureToRecord(feature: NmsFeature): NotamRecord | undefined {
  const n = feature.properties.coreNOTAMData.notam;
  const number = n.number?.trim();
  const location = (n.location ?? n.icaoLocation)?.trim();
  const text = n.text?.trim();
  const issued = isoOrUndefined(n.issued);
  if (!number || !location || !text || !issued) return undefined;

  const effectiveStart = isoOrUndefined(n.effectiveStart) ?? issued;
  const record: NotamRecord = {
    id: n.id?.trim() || `${location}-${number}`,
    number,
    type: n.type?.trim() || "N",
    issued,
    effective_start: effectiveStart,
    location,
    text,
  };
  const year = n.year !== undefined && n.year !== null ? String(n.year) : issued.slice(0, 4);
  if (year) record.year = year;
  const effectiveEnd = isoOrUndefined(n.effectiveEnd);
  if (effectiveEnd) record.effective_end = effectiveEnd;
  if (n.icaoLocation) record.icao_location = n.icaoLocation.trim();
  if (n.airportName) record.airport_name = n.airportName.trim();
  if (n.affectedFir) record.affected_fir = n.affectedFir.trim();
  if (n.selectionCode) record.selection_code = n.selectionCode.trim();
  if (n.classification) record.classification = n.classification.trim();
  if (n.coordinates) record.coordinates = n.coordinates.trim();
  const minFl = toNumber(n.minimumFl);
  const maxFl = toNumber(n.maximumFl);
  if (minFl !== undefined) record.min_fl = minFl;
  if (maxFl !== undefined) record.max_fl = maxFl;
  const radius = toNumber(n.radius);
  if (radius !== undefined) record.radius_nm = radius;
  const pos = firstPosition(feature.geometry);
  if (pos) {
    record.lat = pos.lat;
    record.lon = pos.lon;
  }
  const parsed = NotamRecordSchema.safeParse(record);
  return parsed.success ? parsed.data : undefined;
}

/** Parse an NMS GeoJSON body into canonical records, one per NOTAM id. */
export function parseNmsBody(raw: unknown): NotamRecord[] {
  const parsed = NmsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`NMS payload not recognized: ${JSON.stringify(parsed.error.format()).slice(0, 500)}`);
  }
  const byId = new Map<string, NotamRecord>();
  for (const f of parsed.data.data.geojson) {
    const r = nmsFeatureToRecord(f);
    if (r) byId.set(r.id, r);
  }
  return [...byId.values()];
}

export function radiusNm(radiusMiles: number): number {
  return Math.min(MAX_RADIUS_NM, Math.max(1, Math.round(radiusMiles / MILES_PER_NM)));
}

type CachedToken = { key: string; token: string; expiresAt: number };
let cachedToken: CachedToken | undefined;

/** Test hook: forget the cached bearer token. */
export function resetNmsTokenCache(): void {
  cachedToken = undefined;
}

function basicAuth(id: string, secret: string): string {
  return `Basic ${btoa(`${id}:${secret}`)}`;
}

async function bearerToken(cfg: NmsConfig, now: number, force = false): Promise<string> {
  const key = `${cfg.authUrl}|${cfg.clientId}`;
  if (!force && cachedToken && cachedToken.key === key && cachedToken.expiresAt - TOKEN_RENEW_BUFFER_MS > now) {
    return cachedToken.token;
  }
  const res = await fetch(cfg.authUrl, {
    method: "POST",
    headers: {
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`NMS token request failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("NMS token response had no access_token");
  }
  const ttl = toNumber(body.expires_in) ?? DEFAULT_TOKEN_TTL_S;
  cachedToken = { key, token: body.access_token, expiresAt: now + ttl * 1000 };
  return body.access_token;
}

export function nmsNotamsUrl(cfg: NmsConfig, lat: number, lon: number, radiusMiles: number): string {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    radius: String(radiusNm(radiusMiles)),
  });
  return `${cfg.baseUrl}/v1/notams?${params.toString()}`;
}

export async function fetchNmsNotams(cfg: NmsConfig, ctx: SourceContext, now = Date.now()): Promise<NotamRecord[]> {
  const url = nmsNotamsUrl(cfg, ctx.lat, ctx.lon, ctx.radiusMiles);
  const request = async (token: string) =>
    fetch(url, {
      headers: { Authorization: `Bearer ${token}`, nmsResponseFormat: "GEOJSON", Accept: "application/json" },
    });
  let res = await request(await bearerToken(cfg, now));
  if (res.status === 401 || res.status === 403) {
    // The token may have been revoked early; mint one more and try once.
    res = await request(await bearerToken(cfg, now, true));
  }
  if (!res.ok) throw new Error(`NMS NOTAM request failed: ${res.status} ${res.statusText}`);
  return parseNmsBody(await res.json());
}

export const notamSource: Source<NotamRecord> = {
  name: "NOTAM",
  cadenceMs: 15 * 60 * 1000,
  schema: z.array(NotamRecordSchema),
  isEnabled(ctx: SourceContext) {
    return nmsConfig(ctx.env) !== undefined;
  },
  async fetch(ctx: SourceContext) {
    return fetchNmsNotams(nmsConfig(ctx.env)!, ctx);
  },
  observedAt(data) {
    const times = data.map((r) => epochSeconds(r.issued)).filter((t) => t > 0);
    const fallback = Math.floor(Date.now() / 1000);
    return times.length > 0 ? { min: Math.min(...times), max: Math.max(...times) } : { min: fallback, max: fallback };
  },
};
