/**
 * Regression net for the Worker's public HTTP contract and its tick.
 *
 * These pin the routes, status codes and response shapes production serves
 * today (prime at PR #15), so later releases can change the page without
 * quietly changing the API underneath it. They run the real Worker module
 * against an in-memory D1 stand-in built from migrations/.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import worker, { Env, runTick } from "../src/worker/index";
import { appendLatent, appendPlaceSignal, appendSnapshot, recordSourceRun } from "../src/worker/store";
import { knownSourceNames, sourceNames } from "../src/sources/registry";
import { fakeD1 } from "./helpers/d1";

const BASE = "https://forecast.test";

function envWith(db = fakeD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, ...extra } as Env;
}

async function get(env: Env, path: string, headers: Record<string, string> = { Accept: "application/json" }) {
  const res = await worker.fetch(new Request(BASE + path, { headers }), env);
  const type = res.headers.get("content-type") ?? "";
  const body = type.includes("application/json") ? await res.json() : await res.text();
  return { res, body: body as any };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("every JSON response is no-cache", async () => {
  const env = envWith();
  for (const path of ["/healthz", "/", "/collations/latest", "/no-such-route"]) {
    const { res } = await get(env, path);
    assert.equal(res.headers.get("cache-control"), "no-cache", path);
  }
});

test("GET /healthz", async () => {
  const { res, body } = await get(envWith(), "/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
});

test("GET / lists the endpoint index for JSON clients and HTML otherwise", async () => {
  const env = envWith();
  const { res, body } = await get(env, "/");
  assert.equal(res.status, 200);
  assert.deepEqual(body.endpoints, [
    "/healthz",
    "/sources/status",
    "/field/current",
    ...knownSourceNames().map((s) => `/snapshots/${s}`),
    "/collations/latest",
    "/latents/latest",
    "/latents?name=",
    "/crowdcast",
    "/crowdcast.json",
    "/crowdcast/history?place=",
    "/nearby.json?lat=&lon=",
  ]);

  const page = await get(env, "/", { Accept: "text/html" });
  assert.match(page.res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.body, /<html/i);
});

test("non-GET methods are 405 except POST /ingest/notam", async () => {
  const env = envWith();
  const res = await worker.fetch(new Request(BASE + "/healthz", { method: "POST" }), env);
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: "method_not_allowed" });
});

test("unknown paths are 404 not_found", async () => {
  const { res, body } = await get(envWith(), "/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(body, { error: "not_found" });
});

test("GET /sources/status lists every registered source, never_run until a tick records it", async () => {
  const db = fakeD1();
  await recordSourceRun(db, { source: "METAR", ran_at: 1000, status: "ok", record_count: 6 });
  const { res, body } = await get(envWith(db), "/sources/status");
  assert.equal(res.status, 200);
  assert.deepEqual(
    body.sources.map((s: any) => s.source),
    sourceNames(),
  );
  const metar = body.sources.find((s: any) => s.source === "METAR");
  assert.equal(metar.status, "ok");
  assert.equal(metar.record_count, 6);
  assert.equal(metar.last_ok_at, 1000);
  assert.deepEqual(body.sources.find((s: any) => s.source === "FIRMS"), { source: "FIRMS", status: "never_run" });
});

test("GET /sources/status is 503 before migration 0005", async () => {
  const { res, body } = await get(envWith(fakeD1({ upTo: "0004_rollup.sql" })), "/sources/status");
  assert.equal(res.status, 503);
  assert.equal(body.error, "source_runs_unavailable");
});

test("GET /snapshots/{SOURCE}: unknown source, no snapshot, then the newest snapshot", async () => {
  const db = fakeD1();
  const env = envWith(db);

  assert.equal((await get(env, "/snapshots/NOPE")).body.error, "unknown_source");
  const empty = await get(env, "/snapshots/METAR");
  assert.equal(empty.res.status, 404);
  assert.equal(empty.body.error, "no_snapshot");

  await appendSnapshot(db, { source: "METAR", fetched_at: 1000, observed_at_min: 1, observed_at_max: 2, data: [{ a: 1 }] });
  await appendSnapshot(db, { source: "METAR", fetched_at: 2000, observed_at_min: 3, observed_at_max: 4, data: [{ a: 2 }] });
  const { res, body } = await get(env, "/snapshots/METAR");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["data", "fetched_at", "id", "observed_at_max", "observed_at_min", "source"]);
  assert.equal(body.fetched_at, 2000);
  assert.deepEqual(body.data, [{ a: 2 }]);
});

test("NWS_ALERTS and EVENTS are reachable as snapshot routes", async () => {
  const env = envWith();
  for (const s of ["NWS_ALERTS", "EVENTS", "NOTAM"]) {
    assert.equal((await get(env, `/snapshots/${s}`)).body.error, "no_snapshot", s);
  }
});

test("GET /collations/latest is 404 until a collation exists", async () => {
  const { res, body } = await get(envWith(), "/collations/latest");
  assert.equal(res.status, 404);
  assert.deepEqual(body, { error: "no_collation" });
});

test("GET /latents/latest and /latents?name=", async () => {
  const db = fakeD1();
  const env = envWith(db);
  assert.equal((await get(env, "/latents/latest")).res.status, 404);
  const noName = await get(env, "/latents");
  assert.equal(noName.res.status, 400);
  assert.deepEqual(noName.body, { error: "name_required" });

  await appendLatent(db, { ts: 1000, name: "aqi_max", value: 31, collation_id: 1, inputs: { AIRNOW: 3 }, confidence: 0.9 });
  await appendLatent(db, { ts: 2000, name: "aqi_max", value: 40, collation_id: 2, inputs: { AIRNOW: 3 }, confidence: 0.9 });
  const latest = await get(env, "/latents/latest");
  assert.equal(latest.res.status, 200);
  assert.ok(Array.isArray(latest.body));
  const byName = await get(env, "/latents?name=aqi_max&limit=1");
  assert.equal(byName.body.length, 1);
  assert.equal(byName.body[0].value, 40);
});

test("GET /field/current rejects a bad location before fetching anything", async () => {
  globalThis.fetch = (() => {
    throw new Error("no network in tests");
  }) as typeof fetch;
  for (const [q, err] of [
    ["?lat=39", "lat_lon_required"],
    ["?lat=91&lon=0", "invalid_lat"],
    ["?lat=0&lon=181", "invalid_lon"],
    ["?radius=0", "invalid_radius"],
  ]) {
    const { res, body } = await get(envWith(), "/field/current" + q);
    assert.equal(res.status, 400, q);
    assert.deepEqual(body, { error: err }, q);
  }
});

test("GET /crowdcast serves HTML and /crowdcast.json an empty board before any tick", async () => {
  const env = envWith();
  const page = await get(env, "/crowdcast", {});
  assert.match(page.res.headers.get("content-type") ?? "", /text\/html/);

  const { res, body } = await get(env, "/crowdcast.json");
  assert.equal(res.status, 200);
  assert.equal(body.location, "Kansas City area");
  assert.equal(body.heatAlert, false);
  assert.equal(body.calibrated, false);
  assert.deepEqual(body.parks, []);
});

test("GET /crowdcast.json enriches stored signals with registry fields", async () => {
  const db = fakeD1();
  await appendPlaceSignal(db, {
    ts: 5000,
    place_id: "swope-park",
    signal: "park_crowding",
    value: 72,
    rank: 1,
    demand: 1,
    pull: 0.8,
    friction: 0.1,
    drivers: {},
    narrative: "Busy",
    confidence: 0.5,
  });
  const { body } = await get(envWith(db), "/crowdcast.json");
  assert.equal(body.generated_at, 5000);
  assert.equal(body.parks.length, 1);
  const park = body.parks[0];
  // Registry fields come from the runtime (measured) registry, not the seed.
  assert.equal(park.name, "Swope Park");
  assert.equal(park.holc_grade, "D");
  assert.equal(typeof park.canopy_index, "number");
  assert.equal(typeof park.neighborhood_canopy_index, "number");
  assert.equal(park.water_feature, true);
  for (const k of ["id", "rank", "crowding", "tier", "pull", "friction", "narrative", "confidence"]) {
    assert.ok(k in park, k);
  }
  assert.equal(body.parks[0].crowding, 72);
});

test("GET /crowdcast/history needs a place", async () => {
  const env = envWith();
  const missing = await get(env, "/crowdcast/history");
  assert.equal(missing.res.status, 400);
  assert.deepEqual(missing.body, { error: "place_required" });
  const { body } = await get(env, "/crowdcast/history?place=loose-park");
  assert.deepEqual(body, { place_id: "loose-park", hours: [] });
});

test("GET /nearby.json validates coordinates and reports coverage", async () => {
  const env = envWith();
  // Current behavior, pinned on purpose: missing lat/lon read as 0,0 (Number(null)
  // is 0), so the answer is "not covered" rather than a 400. Fixing this is a
  // contract change and belongs with the public API work, not this net.
  const bare = await get(env, "/nearby.json");
  assert.equal(bare.res.status, 200);
  assert.equal(bare.body.covered, false);
  assert.deepEqual((await get(env, "/nearby.json?lat=abc&lon=0")).body, { error: "lat_lon_required" });
  assert.deepEqual((await get(env, "/nearby.json?lat=95&lon=0")).body, { error: "lat_lon_out_of_range" });

  const far = await get(env, "/nearby.json?lat=40.7&lon=-74.0");
  assert.equal(far.body.covered, false);
  assert.deepEqual(far.body.parks, []);

  const kc = await get(env, "/nearby.json?lat=39.0997&lon=-94.5786&limit=3");
  assert.equal(kc.body.covered, true);
  assert.equal(kc.body.parks.length, 3);
  assert.ok(kc.body.privacy);
  assert.deepEqual(Object.keys(kc.body.picks).sort(), ["closest", "coolest", "least_crowded"]);
  assert.equal(kc.body.picks.least_crowded, null, "no crowd signal before a tick");
});

test("POST /ingest/notam: disabled, unauthorized, then accepted", async () => {
  const db = fakeD1();
  const post = (env: Env, auth?: string, body: unknown = { records: [] }) =>
    worker.fetch(
      new Request(BASE + "/ingest/notam", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: JSON.stringify(body),
      }),
      env,
    );
  assert.equal((await post(envWith(db))).status, 503);
  const env = envWith(db, { INGEST_TOKEN: "t" });
  assert.equal((await post(env, "Bearer wrong")).status, 401);
  const ok = await post(env, "Bearer t");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { accepted: 0 });
});

const METAR_FIXTURE = [
  {
    icaoId: "KMKC",
    receiptTime: "2026-11-28T00:05:00Z",
    obsTime: 1795737600,
    reportTime: "2026-11-28T00:00:00Z",
    temp: 5,
    dewp: -2,
    wdir: 180,
    wspd: 8,
    visib: "10+",
    altim: 1018,
    metarType: "METAR",
    rawOb: "KMKC 280000Z 18008KT 10SM CLR 05/M02 A3006",
    lat: 39.12,
    lon: -94.59,
  },
];

test("runTick records each source's outcome, writes the crowd-cast and collates", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://aviationweather.gov/")) {
      return new Response(JSON.stringify(METAR_FIXTURE), { status: 200 });
    }
    if (url.startsWith("https://api.weather.gov/alerts/")) {
      return new Response(JSON.stringify({ type: "FeatureCollection", features: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const db = fakeD1();
  const env = envWith(db);
  await runTick(env);

  const { body } = await get(env, "/sources/status");
  const status = Object.fromEntries(body.sources.map((s: any) => [s.source, s.status]));
  assert.equal(status.METAR, "ok");
  assert.equal(status.NWS_ALERTS, "empty");
  for (const s of ["AIRNOW", "FIRMS", "HRRR_SMOKE", "NEXRAD", "NLDN", "EVENTS", "NOTAM"]) {
    assert.equal(status[s], "disabled", s);
  }

  // An empty batch is not persisted; a non-empty one is.
  assert.equal((await get(env, "/snapshots/NWS_ALERTS")).body.error, "no_snapshot");
  const metar = await get(env, "/snapshots/METAR");
  assert.equal(metar.body.observed_at_min, 1795737600);

  const cast = await get(env, "/crowdcast.json");
  assert.ok(cast.body.parks.length > 0);
  assert.equal(cast.body.temperatureF, 41);

  const c = await get(env, "/collations/latest");
  assert.equal(c.res.status, 200);
  assert.deepEqual(Object.keys(c.body.sources), ["METAR"]);
});
