/**
 * Regression net for observation decoding: each adapter's fetch, run against
 * a stubbed upstream, returns the records and time bounds it does today.
 *
 * Source fidelity (F3) is pinned here too: METAR gusts and extra fields are
 * kept and "10+" visibility reads as 10, NWS alerts keep their area, zone
 * codes and polygon, and AirNow's local hour is read in its own time zone.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { gustKt, metarSource, visibilitySm } from "../src/sources/metar";
import { airnowObservedAtSeconds, airnowSource, parseAirNowBody, readAirNow } from "../src/sources/airnow";
import { deriveLatents } from "../src/latents";
import { firmsSource } from "../src/sources/firms";
import { hrrrSmokeSource } from "../src/sources/hrrr_smoke";
import { nldnSource } from "../src/sources/nldn";
import { nwsAlertsSource } from "../src/sources/nws_alerts";
import { SourceContext } from "../src/sources/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(body: string, status = 200) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return new Response(status === 204 ? null : body, { status });
  }) as typeof fetch;
  return seen;
}

const ctx = (env: Record<string, string> = {}): SourceContext => ({ lat: 39.0997, lon: -94.5786, radiusMiles: 30, env });

test("METAR keeps a station that leaves sensors out or reports variable wind", async () => {
  stub(
    JSON.stringify([
      {
        icaoId: "KMKC",
        receiptTime: "2026-11-28T00:05:00Z",
        obsTime: 1795737600,
        reportTime: "2026-11-28T00:00:00Z",
        temp: null,
        wdir: "VRB",
        wspd: 3,
        visib: "10+",
        metarType: "METAR",
        rawOb: "KMKC 280000Z VRB03KT 10SM CLR",
        lat: 39.12,
        lon: -94.59,
      },
    ]),
  );
  const rows = await metarSource.fetch(ctx());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wdir, "VRB");
  assert.equal(rows[0].visib, "10+");
  assert.equal(rows[0].temp, null);
  assert.deepEqual(metarSource.observedAt(rows), { min: 1795737600, max: 1795737600 });
});

test("METAR treats 204 and an empty body as no stations, and a 5xx as an error", async () => {
  stub("", 204);
  assert.deepEqual(await metarSource.fetch(ctx()), []);
  stub("  ");
  assert.deepEqual(await metarSource.fetch(ctx()), []);
  stub("oops", 502);
  await assert.rejects(metarSource.fetch(ctx()), /METAR fetch failed: 502/);
});

test("METAR rejects a record missing a required field", async () => {
  stub(JSON.stringify([{ icaoId: "KMKC" }]));
  await assert.rejects(metarSource.fetch(ctx()));
});

test("FIRMS reads VIIRS CSV into typed rows with UTC acquisition times", async () => {
  assert.equal(firmsSource.isEnabled(ctx()), false);
  const seen = stub(
    [
      "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
      "39.01,-94.40,330.5,0.39,0.36,2026-11-27,0754,N,VIIRS,n,2.0NRT,290.1,4.2,N",
    ].join("\n"),
  );
  const rows = await firmsSource.fetch(ctx({ FIRMS_MAP_KEY: "k" }));
  assert.match(seen[0], /\/api\/area\/csv\/k\/VIIRS_SNPP_NRT\//);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].frp, 4.2);
  assert.equal(rows[0].confidence, "n");
  const t = Date.UTC(2026, 10, 27, 7, 54) / 1000;
  assert.deepEqual(firmsSource.observedAt(rows), { min: t, max: t });
});

test("FIRMS header-only CSV is empty", async () => {
  stub("latitude,longitude,acq_date,acq_time\n");
  assert.deepEqual(await firmsSource.fetch(ctx({ FIRMS_MAP_KEY: "k" })), []);
});

test("HRRR Smoke is bounded by valid time", async () => {
  assert.equal(hrrrSmokeSource.isEnabled(ctx()), false);
  stub(
    JSON.stringify([
      { runTs: 100, validTs: 200, lat: 39, lon: -94.5, near_surface_smoke: 3.1 },
      { runTs: 100, validTs: 260, lat: 39.1, lon: -94.6, near_surface_smoke: 1.2 },
    ]),
  );
  const rows = await hrrrSmokeSource.fetch(ctx({ HRRR_SMOKE_ENDPOINT: "https://smoke.test/q" }));
  assert.deepEqual(hrrrSmokeSource.observedAt(rows), { min: 200, max: 260 });
});

test("NLDN decodes strokes", async () => {
  assert.equal(nldnSource.isEnabled(ctx()), false);
  stub(JSON.stringify([{ ts: 500, lat: 39, lon: -94.5, peak_kA: -22, type: "CG" }]));
  const rows = await nldnSource.fetch(ctx({ NLDN_TOKEN: "t", NLDN_ENDPOINT: "https://nldn.test/q" }));
  assert.equal(rows[0].peak_kA, -22);
});

test("NWS alerts flatten each feature's properties under its id", async () => {
  const seen = stub(
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          id: "urn:oid:2.49.0.1.840.0.abc",
          properties: {
            event: "Wind Advisory",
            headline: "Wind Advisory until 6 PM",
            severity: "Moderate",
            sent: "2026-11-27T15:00:00-06:00",
            onset: "2026-11-27T16:00:00-06:00",
          },
        },
      ],
    }),
  );
  const rows = await nwsAlertsSource.fetch(ctx());
  assert.match(seen[0], /alerts\/active\?point=39\.0997,-94\.5786$/);
  assert.equal(rows[0].id, "urn:oid:2.49.0.1.840.0.abc");
  assert.equal(rows[0].event, "Wind Advisory");
  const onset = Date.UTC(2026, 10, 27, 22) / 1000;
  assert.deepEqual(nwsAlertsSource.observedAt(rows), { min: onset, max: onset });
});

const metarRow = (extra: Record<string, unknown>) => ({
  icaoId: "KMCI",
  receiptTime: "2026-11-28T00:05:00Z",
  obsTime: 1795737600,
  reportTime: "2026-11-28T00:00:00Z",
  metarType: "METAR",
  rawOb: "KMCI 280000Z 27012KT 10SM CLR",
  lat: 39.3,
  lon: -94.7,
  ...extra,
});

test("METAR keeps gusts and fields the schema does not name", async () => {
  stub(
    JSON.stringify([
      metarRow({ wspd: 18, wgst: 29, presTend: -1.2, maxT: 12 }),
      metarRow({ icaoId: "KMKC", wspd: 15, wg: 24 }),
      metarRow({ icaoId: "KLXT", wspd: 16, rawOb: "KLXT 280000Z 25016G27KT 10SM CLR" }),
      metarRow({ icaoId: "KOJC", wspd: 6 }),
    ]),
  );
  const rows = await metarSource.fetch(ctx());
  assert.equal((rows[0] as Record<string, unknown>).presTend, -1.2);
  assert.equal((rows[0] as Record<string, unknown>).maxT, 12);
  assert.deepEqual(rows.map(gustKt), [29, 24, 27, undefined]);
  assert.equal(gustKt({ rawOb: "KMKC 280000Z VRB05G15KT 10SM CLR" }), 15);
});

test("METAR visibility reads 10+, fractions and numbers as statute miles", () => {
  const cases: Array<[unknown, number | undefined]> = [
    [10, 10],
    ["10+", 10],
    ["6", 6],
    ["1/2", 0.5],
    ["1 1/2", 1.5],
    ["M1/4", 0.25],
    ["P6SM", 6],
    [null, undefined],
    [undefined, undefined],
    ["", undefined],
    ["garbled", undefined],
  ];
  for (const [visib, want] of cases) assert.equal(visibilitySm({ visib }), want, String(visib));
});

test("clear-sky stations count toward lowest visibility, and gusts reach convective disruption", () => {
  const collation = {
    id: 1,
    collated_at: 1000,
    observed_at_min: 0,
    observed_at_max: 100,
    sources: Object.fromEntries(["METAR", "NEXRAD", "NLDN"].map((s) => [s, { snapshot_id: 1, fetched_at: 1000, record_count: 1 }])),
  };
  const metar = [
    metarRow({ visib: "10+", fltCat: "VFR" }),
    metarRow({ icaoId: "KLXT", visib: "10+", fltCat: "VFR", rawOb: "KLXT 280000Z 25016G34KT 10SM CLR" }),
  ];
  const latents = deriveLatents(collation, (s) =>
    s === "METAR" ? { data: metar } : s === "NEXRAD" ? { data: [{ station: "KEAX" }] } : s === "NLDN" ? { data: [] } : null,
  );
  assert.equal(latents.find((l) => l.name === "visibility_min_sm")?.value, 10);
  assert.equal(latents.find((l) => l.name === "convective_disruption_signal")?.inputs.max_gust_kt, 34);
});

const airnowRow = (extra: Record<string, unknown>) => ({
  dateObserved: "2026-11-27",
  hourObserved: 18,
  localTimeZone: "CST",
  reportingAreaName: "Kansas City",
  parameterName: "PM2.5",
  aqi: 31,
  ...extra,
});

test("AirNow reads the observation hour in the reporting area's own time zone", () => {
  // 18:00 CST on Nov 27 is 00:00 UTC on Nov 28.
  const cst = Date.UTC(2026, 10, 28, 0) / 1000;
  assert.deepEqual(airnowSource.observedAt(parseAirNowBody([airnowRow({})])), { min: cst, max: cst });
  // 18:00 CDT is 23:00 UTC the same day.
  assert.equal(airnowObservedAtSeconds(readAirNow(airnowRow({ localTimeZone: "CDT" }))!), Date.UTC(2026, 10, 27, 23) / 1000);
  // Legacy PascalCase rows carry the same zone field.
  const legacy = { DateObserved: "2026-11-27 ", HourObserved: 18, LocalTimeZone: "CST", ReportingArea: "Kansas City", ParameterName: "O3", AQI: 22 };
  assert.equal(airnowObservedAtSeconds(readAirNow(legacy)!), cst);
});

test("AirNow does not guess at a zone it does not know", () => {
  assert.equal(airnowObservedAtSeconds(readAirNow(airnowRow({ localTimeZone: "XST" }))!), undefined);
  assert.equal(airnowObservedAtSeconds(readAirNow(airnowRow({ localTimeZone: undefined }))!), undefined);
  const before = Math.floor(Date.now() / 1000);
  const { min } = airnowSource.observedAt(parseAirNowBody([airnowRow({ localTimeZone: "XST" })]));
  assert.ok(min >= before, "an unknown zone falls back to fetch time, as a missing hour does");
});

test("NWS alerts keep their area, zone codes and polygon", async () => {
  const polygon = { type: "Polygon", coordinates: [[[-94.7, 39.0], [-94.5, 39.0], [-94.5, 39.2], [-94.7, 39.0]]] };
  stub(
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          id: "urn:storm",
          geometry: polygon,
          properties: {
            event: "Severe Thunderstorm Warning",
            areaDesc: "Jackson, MO; Wyandotte, KS",
            geocode: { SAME: ["029095", "020209"], UGC: ["MOC095", "KSC209"] },
            onset: "2026-11-27T16:00:00-06:00",
          },
        },
        {
          id: "urn:zone",
          geometry: null,
          properties: { event: "Wind Advisory", areaDesc: "Jackson; Clay", geocode: { UGC: ["MOZ028", "MOZ029"] }, onset: "2026-11-27T16:00:00-06:00" },
        },
      ],
    }),
  );
  const rows = await nwsAlertsSource.fetch(ctx());
  assert.deepEqual(rows[0].geometry, polygon);
  assert.equal(rows[0].areaDesc, "Jackson, MO; Wyandotte, KS");
  assert.deepEqual(rows[0].geocode?.UGC, ["MOC095", "KSC209"]);
  assert.equal(rows[1].geometry, null);
  assert.deepEqual(rows[1].geocode?.UGC, ["MOZ028", "MOZ029"]);
});
