# Baseline record

What Forecast is and does at the start of the build-out, so every later change can be measured against it. It covers steps 1 to 44 of the reconstruction plan. Step numbers are in brackets.

The record was taken on prime at `0957960` (PR #15), read from the repository and from the production D1 database directly. Counts are as of the end of November 2026 and will drift; the shape is what matters.

## Repository and runtime

**Revision [1, 2].** Prime is `0957960`. The deployed Worker bundle was checked against it after the PR #15 deploy and matches: it carries `source_runs`, `/sources/status`, the AirNow `ziplatlong` service and the FAA NMS client.

**Structure [3].** About 5,700 lines of TypeScript in `src/`, 9 source adapters, 5 migrations, 9 test files before this record (57 tests). `CLAUDE.md` holds the file map. Two docs have drifted: `docs/architecture.md` names a `src/ingest.ts` that no longer exists (ingestion lives in `src/sources/`), and its layer table predates the latents, field and crowd-cast modules.

**Frontend entry points [4, 5, 6].**

- `src/frontend.ts` renders `/` as one server-built HTML string of about 900 lines, with its CSS and script inline. It has no components, build step or client framework.
- On load the page calls `/healthz`, then `/field/current` (with the browser's location when the visitor allows it), and reads snapshot routes from `/`.
- `src/crowdcast_page.ts` renders `/crowdcast` the same way and calls `/crowdcast.json`.
- The root `index.html` and `CNAME` (`forecast.meansandmeasures.com`) are left from a GitHub Pages version and are not served by the Worker.

**Source adapters [7].** Each adapter in `src/sources/` implements `Source` (`name`, `cadenceMs`, Zod `schema`, `isEnabled`, `fetch`, `observedAt`) and is listed in `registry.ts`. The table under Sources below lists what each returns.

**Field construction [8].** `src/field.ts` builds `/field/current` per request: it fetches every enabled source live for the requested point and radius, derives latents from that transient collation and returns the lot. Nothing on this path is stored. Each page view therefore makes one call to every enabled upstream.

**Inference [9].** `src/latents.ts` derives named signals from a collation. The Latents section lists them.

**Park demand [10].** `src/parks.ts` ranks parks by relative crowding from day type, hour, temperature, heat alerts and each park's static pull (size, canopy, water, amenities) less friction. It is a model with no observed counts behind it; `foot_traffic` is an empty seam. `docs/compendium/parks.md` has the method.

**Place registry [11].** `src/places.ts` prefers `src/places.generated.json` (220 measured parks: OSM geometry, NLCD canopy and impervious surface, HOLC grade, neighborhood canopy) and falls back to a hand-made seed. The board shows 24 of the 220. Every park is category `park`, none has access points, and summer surface heat is a proxy from impervious cover, not land-surface temperature.

**Storage, collation and routing [12, 13, 14].** `src/worker/store.ts` is the D1 store, `src/worker/collate.ts` the collation and `src/worker/index.ts` the routes and the tick. The Node runtime mirrors them in `src/store.ts`, `src/collate.ts` and `src/server.ts` against SQLite.

**Scheduled work [15].** One cron, `*/5 * * * *`. Each firing runs every enabled source in parallel (the Worker ignores `cadenceMs`), records each outcome in `source_runs`, writes one crowd-cast row per board park, runs the hourly rollup at most once an hour, then collates and derives latents.

**Database [16, 17, 18].** About 625 MB.

| Table | Indexes | Notes |
|---|---|---|
| `snapshots` | source, fetched_at | append-only, `data` is the JSON observation array |
| `collations` | collated_at | append-only |
| `latents` | ts; name, ts | append-only |
| `place_signals` | ts; place_id, ts; signal, ts | raw crowd-cast, pruned only if `PLACE_SIGNALS_RETENTION_DAYS` is set (it isn't) |
| `place_signals_hourly` | hour_ts; place_id, hour_ts | the only rollup |
| `places` | none | created by 0003, empty: the registry ships in the bundle |
| `maintenance_state` | key | rollup bookmarks |
| `source_runs` | source | last outcome per source |

There is no rollup for snapshots or latents, so any history view reads raw rows. `d1_migrations` records all five migrations.

**Tests and validation gate [19, 20].** `npm run verify:full` runs the TypeScript build, the test suite, the NOTAM relay's build and tests, and a Worker dry-run bundle. CI runs the same on every PR that touches code. Before this record: 57 tests, all passing. This PR adds the regression net described in [Regression net](#regression-net).

**Deployment [21].** Manual, from the maintainer's machine, through `scripts/deploy-direct.mjs`. It refuses anything but a clean prime checkout from `meansandmeasures/forecast`, runs `verify:full`, deploys with Wrangler, then checks `/healthz`. That health check only proves the Worker answers. Whether each source is flowing is checked by hand at `/sources/status`.

## Live endpoints [22 to 29]

| Route | What it returns now |
|---|---|
| `/field/current` | a transient field for a point: per-source status and records, plain observations and latents. Fetched live per request. |
| `/sources/status` | METAR ok (6 stations), AIRNOW ok (3 readings), NEXRAD ok (KEAX latest volume), FIRMS and NWS_ALERTS empty, HRRR_SMOKE, NLDN, EVENTS and NOTAM disabled |
| `/latents/latest`, `/latents?name=` | stored latents; `name` is required |
| `/collations/latest` | the newest collation; lately METAR, AIRNOW and NEXRAD |
| `/snapshots/{SOURCE}` | the newest stored snapshot for a registered source |
| `/crowdcast.json` | the newest board: 24 parks with crowding, tier, drivers and narrative, `calibrated: false` |
| `/crowdcast/history?place=` | hourly rollup rows for one park; `place` is required |
| `/nearby.json?lat=&lon=` | parks near a point with closest, least crowded and coolest picks. Missing `lat`/`lon` read as 0,0 and answer "not covered" instead of 400. |

## Sources [30 to 33, 41, 42]

| Source | State | Observation | Where | When | Units and normalization |
|---|---|---|---|---|---|
| METAR | flowing | station report: temp, dewpoint, wind, visibility, altimeter, clouds, weather, flight category | station lat/lon | `obsTime` (epoch s) | °C, knots, statute miles (`"10+"` kept as a string), hPa. Gusts arrive as `wgst` and are dropped by the strict schema. |
| AIRNOW | flowing | AQI per pollutant at a reporting area | area lat/lon | date + local hour | AQI. The local hour is read as UTC, so `observed_at` is 6 hours early in the Worker. |
| NEXRAD | flowing, metadata only | the newest Level II volume's key and time per station | station id | volume time | none: no reflectivity is decoded, so there is nothing to draw yet [42] |
| FIRMS | enabled, empty lately | VIIRS thermal detection: brightness, FRP, confidence | detection lat/lon | `acq_date` + `acq_time` (UTC) | Kelvin, MW |
| NWS_ALERTS | enabled, empty lately | active alert text and timing | queried by point only; geometry and `areaDesc` are dropped | sent, effective, onset, expires, ends | none |
| HRRR_SMOKE | configured, off | modeled near-surface smoke | grid point | `validTs` | µg/m³, needs a proxy that doesn't exist [41] |
| NLDN | configured, off | lightning stroke, peak current, type | stroke lat/lon | `ts` | kA, needs a subscription [41] |
| EVENTS | configured, off | PredictHQ local events | venue lat/lon | start and end | needs a key [41] |
| NOTAM | configured, off | FAA NOTAM text and classification | NMS radius query | issued, effective | needs FAA NMS credentials [41] |

## Latents [34, 35, 36, 38]

Values are what each name computes. Confidence is set only where noted; elsewhere it is stored as null, which means "not stated", not "low".

| Latent | Inputs | Meaning | Confidence | Stored rows |
|---|---|---|---|---|
| `civic_temporal_rhythm` | local hour, weekday, day type, events | expected human presence, 0 to 100 | 0.65, or 0.85 with an event | 28k, since Jul 23 |
| `aqi_max` | AIRNOW | peak AQI across readings | null | 34k, since Jun 6 |
| `visibility_min_sm` | METAR `visib` | lowest numeric visibility | null | 7.6k, last Oct 29. Clear-sky `"10+"` is not a number, so clear days write nothing. |
| `declared_weather_hazard` | NWS_ALERTS | 100 warning, 80 watch, 65 other | 0.85 to 1 by certainty | 6.8k, last Nov 7 |
| `fire_detection_count` | FIRMS | detections in radius | null | 5.7k, last Oct 29 |
| `smoke_impacted_aq` | AIRNOW + FIRMS | particle AQI when fires are present | fires / 10, capped at 1 | 4.4k, last Sep 29 |
| `advective_smoke_provenance` | FIRMS + METAR wind (+ AIRNOW, HRRR) | fires in the upwind sector strong enough to carry smoke | share of inputs present | 3.7k, last Oct 29 |
| `compound_field_stress` | every family present | how many hazard families are elevated at once | families / 4 | 18k, last Nov 7 |
| `hrrr_smoke_max`, `lightning_strike_count`, `declared_operational_constraint`, `smoke_transport_pressure`, `respiratory_visibility_stress`, `convective_disruption_signal`, `constraint_collision`, `unannounced_disruption_potential` | sources that are off | defined in code, never produced in production | | 0 |

Where confidence comes from "share of inputs present" (`confidenceFromPresence`), it measures coverage, not accuracy.

## History [37, 38, 39]

| Series | Rows | Span | Gaps |
|---|---|---|---|
| METAR snapshots | 35k | Jun 5 to now | nothing from Oct 30 to Nov 27 |
| AIRNOW snapshots | 33k | Jun 5 to now | nothing from Oct 1 to Nov 27 |
| FIRMS snapshots | 5.2k | Jun 12 to Oct 28 | |
| NWS_ALERTS snapshots | 6.6k | Jul 27 to Nov 7 | empty since: no active alerts is not stored |
| NEXRAD snapshots | 8 | since the Nov 27 deploy | |
| Collations | 42k | Jun 5 to now | none from Nov 7 to Nov 27 |
| `place_signals` | 866k | Jul 23 to now | 31 distinct park ids over time (the seed and measured boards differ) |
| `place_signals_hourly` | 72k | | |
| Observed foot traffic | 0 | | Crowd-Cast has never been checked against real counts |

## What the registry supports [40]

Per park: name, centroid, area, HOLC grade (where mapped), park and neighborhood canopy, neighborhood impervious surface, a heat proxy, a noise proxy, water, amenities and provenance. Not present: entrances, paths, shade geometry, restrooms or water fountains as points, hours, transit access, or anything for places other than parks.

## Capability split [43, 44]

**Supported today, from flowing data:** current weather and visibility from METAR, air quality from AirNow, park comparisons from the registry and the model, the hourly crowd-cast history, and history charts over the spans above.

**Needs a fix to data already arriving:** gusts (METAR schema), AirNow time zone, clear-sky visibility, alert areas for a map (NWS geometry), and a 400 on `/nearby.json` without coordinates. F3 fixes the first four for snapshots written from then on; snapshots already stored keep what they were written with, since storage is append-only.

**Needs new acquisition or infrastructure:** radar imagery (decode Level II or take a rendered product), modeled smoke (an HRRR proxy), lightning (NLDN subscription), events (PredictHQ key), NOTAM (FAA NMS credentials), observed foot traffic (none chosen; decision 5 is to buy none for now), and a vector basemap (decision 2: self-hosted).

## Regression net

Steps 45 to 60 ask that today's behavior be pinned before anything changes. These tests do that:

| Step | Covered by |
|---|---|
| 45 API contracts | `test/worker.test.ts` (Worker routes, codes, shapes) and `test/server.test.ts` (Node) |
| 46 observation decoding | `test/decoding.test.ts`, `test/sources.test.ts`, `test/nws_alerts.test.ts`, `test/events.test.ts`, `test/notam.test.ts` |
| 47 latent calculations | `test/latents.test.ts` |
| 48 park demand | `test/parks.test.ts` |
| 49 collation | `test/collate.test.ts` (Node), `test/storage.test.ts` (D1) |
| 50 append-only storage | `test/storage.test.ts` |
| 51 to 60 preserved responsibilities | the same suite: sources, field, latents, parks, attribution and the five-minute Worker tick stay where they are, and a change that moves one fails a test |

Three known faults are deliberately left unpinned so the fixes can land without fighting the net: METAR gusts, NWS geometry and the AirNow time zone. F3 fixed them and pins the fixes in `test/decoding.test.ts`. The `/nearby.json` 0,0 behavior is pinned with a comment, because changing it changes the public contract.
