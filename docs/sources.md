> The system maintains parallel interpretation paths derived from shared observations.  
> These paths are updated iteratively and may diverge or converge over time, rather than being reduced to a single resolved state prematurely.  
> 
> Authoritative outputs and directives are produced as a time-bound coalescence of these paths, weighted according to their state at that point, and shall be acted upon within that context.

# Sources

This document specifies the `Source` interface, the procedure for onboarding a new source, and per-source detail for every source currently in the registry. Source fidelity is preserved; source authority is not asserted.

---

## The `Source` Interface

Every source is a value implementing `Source<T>` from `src/sources/types.ts`:

```ts
interface Source<T> {
  name: string;                                 // stable identifier (UPPER_SNAKE)
  cadenceMs: number;                            // minimum interval between fetches (Node)
  schema: z.ZodType<T[]>;                       // validated response shape
  isEnabled(ctx: SourceContext): boolean;       // false when env is missing
  fetch(ctx: SourceContext): Promise<T[]>;      // returns validated observations
  observedAt(data: T[]): { min: number; max: number };  // epoch-seconds bounds
}
```

Sources are listed in `src/sources/registry.ts`. The runtime iterates the registry and:

- **SHALL** skip a source whose `isEnabled` returns false. Disabled sources are not error states.
- **MAY** skip a source whose `cadenceMs` has not elapsed since its previous fetch.
- **MUST NOT** persist an empty observation array.
- **MUST NOT** transform, normalize, or rename upstream fields.

---

## Onboarding Procedure

1. Add a new module `src/sources/<name>.ts` exporting a `Source` value.
2. Define the Zod schema. Field names **MUST** match the upstream response exactly.
3. Implement `isEnabled` to check for the credentials or configuration the source requires. A source with no preconditions returns `true`.
4. Implement `fetch` to obtain raw data, validate it with the schema, and return the array. Validation failure **MUST** throw.
5. Implement `observedAt` to extract epoch-seconds bounds from the validated payload. If the source carries no per-observation timestamp, return the fetch time for both bounds.
6. Register the source in `src/sources/registry.ts`.

> [!CAUTION]
> A source whose response shape is unstable **MUST NOT** be added without explicit handling of the variation in its Zod schema. Silent coercion is a structural failure.

No further edits to `store`, `collate`, `server`, or the Worker entry are required. The registry is the single point of truth.

---

## Active Sources

### METAR — `src/sources/metar.ts`

Surface aviation weather observations.

- **Endpoint**: `https://aviationweather.gov/api/data/metar?bbox={S,W,N,E}&format=json`
- **Authentication**: none; requests carry a `User-Agent`, as AWC asks of API clients
- **Geographic resolution**: bounding box from `USER_LAT`, `USER_LON`, `RADIUS_MILES`, rounded to four decimals (AWC answers 400 to long float tails)
- **Variation**: a station may omit or null any sensor field and sends `"VRB"` for variable wind; the schema allows both rather than dropping the batch
- **Cadence**: 5 minutes
- **Always enabled**

### AIRNOW — `src/sources/airnow.ts`

Surface air quality observations (O3, PM2.5, PM10).

- **Endpoint**: `https://www.airnowapi.org/aq/observation/current/ziplatlong/?latitude=&longitude=&API_KEY=&format=application/json`
- **Authentication**: `AIRNOW_API_KEY` (free)
- **History**: AirNow retired `/aq/observation/latLong/current/` on 2026-10-01; it answers 410. The current service picks the nearest reporting area itself and ignores `distance`.
- **Variation**: the current service names fields in camelCase (`reportingAreaName`, `parameterName`, `nowcastAQI`, `aqiCategoryName`, `hourObserved` as `"HH:MM"`). Rows are stored as sent; older snapshots hold the retired service's PascalCase rows. Downstream code reads both through `readAirNow` in `src/sources/airnow.ts`.
- **Empty result**: HTTP 200 with a `{"WebServiceError":[…]}` envelope. That is treated as empty, except a retirement or key error, which fails the run.
- **Cadence**: 5 minutes
- **Enabled when**: `AIRNOW_API_KEY` is set

### FIRMS — `src/sources/firms.ts`

Active fire detections from VIIRS (NASA FIRMS).

- **Endpoint**: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/VIIRS_SNPP_NRT/{bbox}/1`
- **Authentication**: `FIRMS_MAP_KEY`
- **Format**: CSV; parsed in-source
- **Cadence**: 60 minutes
- **Enabled when**: `FIRMS_MAP_KEY` is set

### HRRR_SMOKE — `src/sources/hrrr_smoke.ts`

Surface and column smoke from HRRR-Smoke, expected via a JSON proxy (the upstream native format is GRIB2 and is **NOT** decoded in-process).

- **Endpoint**: configured via `HRRR_SMOKE_ENDPOINT`
- **Authentication**: none beyond the endpoint URL
- **Cadence**: 60 minutes
- **Enabled when**: `HRRR_SMOKE_ENDPOINT` is set

### NEXRAD — `src/sources/nexrad.ts`

Latest Level-2 radar scan metadata from `s3://unidata-nexrad-level2`. This source records *the existence and key of* the most recent scan per station. It **DOES NOT** decode the radar volume.

- **Endpoint**: `https://unidata-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix={YYYY}/{MM}/{DD}/{STATION}/&max-keys=1000`
- **Authentication**: none
- **Cadence**: 10 minutes
- **Enabled when**: `NEXRAD_STATIONS` is set (comma-separated station IDs). Production sets `KEAX` (Kansas City / Pleasant Hill) in `wrangler.toml`.
- **Selection**: S3 lists keys in ascending order, so the newest volume is the last non-`_MDM` key of the UTC day, falling back to the previous day just after midnight. A run where every station's listing fails is an error, not an empty result.

### NLDN — `src/sources/nldn.ts`

Lightning detections from the National Lightning Detection Network. Subscription-gated.

- **Endpoint**: configured via `NLDN_ENDPOINT`
- **Authentication**: `Bearer NLDN_TOKEN`
- **Cadence**: 5 minutes
- **Enabled when**: both `NLDN_TOKEN` and `NLDN_ENDPOINT` are set

### EVENTS — `src/sources/events.ts`

Local event context. This is a canonical event-context adapter rather than a single upstream-native shape, so each record carries `provider` and `provider_id`. PredictHQ is the first provider; Ticketmaster, KCMO/Socrata, Eventbrite, and other adapters can be added later without changing downstream latent inputs.

- **Endpoint**: `https://api.predicthq.com/v1/events/`
- **Authentication**: `Bearer PREDICTHQ_API_KEY`
- **Geographic resolution**: `within={RADIUS_MILES}mi@{USER_LAT},{USER_LON}`
- **Window**: `EVENTS_LOOKAHEAD_HOURS` from fetch time, default 24
- **Timezone**: `EVENTS_TIMEZONE`, default `America/Chicago`
- **Cadence**: 30 minutes
- **Enabled when**: `PREDICTHQ_API_KEY` is set
- **Notes**: Event completeness is subscription and provider dependent. Absence of event rows is not proof that no events exist.

### NOTAM — `src/sources/notam.ts` (polled)

Airspace notices from the FAA NOTAM Management Service (NMS) API, polled by the same tick as every other source. No always-on process is needed.

- **Token**: `POST {FAA_NMS_AUTH_URL}` with HTTP Basic `client_id:client_secret` and `grant_type=client_credentials`; the bearer token is cached per isolate and renewed a minute before it expires
- **Endpoint**: `GET {FAA_NMS_BASE_URL}/v1/notams?latitude=&longitude=&radius=` with header `nmsResponseFormat: GEOJSON`; `radius` is nautical miles from `RADIUS_MILES`, capped at 100
- **Defaults**: production, `https://api-nms.aim.faa.gov/nmsapi` and `https://api-nms.aim.faa.gov/v1/auth/token`. Staging is `https://api-staging.cgifederal-aim.com/nmsapi` and `/v1/auth/token` on the same host.
- **Authentication**: `FAA_NMS_CLIENT_ID` and `FAA_NMS_CLIENT_SECRET`, issued by the FAA on request (not self-serve)
- **Schema**: each GeoJSON feature's `properties.coreNOTAMData.notam` is mapped to the canonical `NotamRecord` in `src/notam-schema.ts`. Features without a number, location, text or issue time are dropped; `PERM` and other non-dates leave `effective_end` unset.
- **Cadence**: 15 minutes (Node); every cron firing on the Worker
- **Enabled when**: both NMS credentials are set
- **Caveat**: the FAA hands out the endpoint documentation with the credentials. The paths, header and field names here follow the published NMS clients and **SHOULD** be checked against that documentation on first use.

### NOTAM — `relay/notam/` (optional push)

The SWIM JMS relay still works and writes into the same `NOTAM` snapshots, but nothing requires it. It needs a host with persistent outbound TLS to `tcps://ems1.swim.faa.gov:55443`, which the Worker cannot open.

- **Upstream**: FAA SWIM, message VPN `AIM_FNS`, AIXM 5.1 Basic Messages with FNS Event extensions
- **Authentication (upstream)**: Solace username + password + queue, provisioned through the SWIM portal
- **Authentication (downstream)**: relay POSTs to the Worker at `/ingest/notam` with bearer `INGEST_TOKEN`
- **Schema**: canonical `NotamRecord` declared in `src/notam-schema.ts`; the AIXM XML is **NOT** preserved
- **Filtering**: relay drops records outside `USER_LAT/LON + RADIUS_MILES` before forwarding (set `GEO_FILTER=0` to forward the national firehose)
- **Cadence**: continuous — no polling; messages arrive as the FAA publishes them
