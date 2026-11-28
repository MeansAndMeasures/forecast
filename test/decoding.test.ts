/**
 * Regression net for observation decoding: each adapter's fetch, run against
 * a stubbed upstream, returns the records and time bounds it does today.
 *
 * Known gaps that later work fixes on purpose (and will update here) are left
 * unpinned: METAR gusts, NWS alert geometry, and AirNow's time zone.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { metarSource } from "../src/sources/metar";
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
