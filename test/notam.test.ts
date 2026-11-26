import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchNmsNotams,
  nmsConfig,
  nmsNotamsUrl,
  parseNmsBody,
  radiusNm,
  resetNmsTokenCache,
  NMS_PRODUCTION_BASE_URL,
} from "../src/sources/notam";
import { knownSourceNames, sourceNames } from "../src/sources/registry";

const nmsBody = {
  data: {
    geojson: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-94.7139, 39.2976] },
        properties: {
          coreNOTAMData: {
            notam: {
              id: "NOTAM_1_123",
              number: "11/042",
              type: "N",
              issued: "2026-11-25T18:00:00.000Z",
              location: "MCI",
              icaoLocation: "KMCI",
              effectiveStart: "2026-11-25T18:00:00.000Z",
              effectiveEnd: "PERM",
              text: "RWY 01L/19R CLSD",
              classification: "DOMESTIC",
              radius: "5",
            },
          },
        },
      },
      { type: "Feature", properties: { coreNOTAMData: { notam: { number: "11/043" } } } },
    ],
  },
};

test("NMS GeoJSON maps to canonical NOTAM records", () => {
  const rows = parseNmsBody(nmsBody);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, "NOTAM_1_123");
  assert.equal(r.location, "MCI");
  assert.equal(r.year, "2026");
  assert.equal(r.effective_end, undefined, "PERM is open-ended, not a date");
  assert.equal(r.radius_nm, 5);
  assert.deepEqual({ lat: r.lat, lon: r.lon }, { lat: 39.2976, lon: -94.7139 });
});

test("NMS is disabled without both credentials and defaults to production", () => {
  assert.equal(nmsConfig({}), undefined);
  assert.equal(nmsConfig({ FAA_NMS_CLIENT_ID: "a" }), undefined);
  const cfg = nmsConfig({ FAA_NMS_CLIENT_ID: "a", FAA_NMS_CLIENT_SECRET: "b" });
  assert.equal(cfg?.baseUrl, NMS_PRODUCTION_BASE_URL);
  assert.equal(radiusNm(30), 26);
  assert.equal(radiusNm(500), 100);
  const url = new URL(nmsNotamsUrl(cfg!, 39.0997, -94.5786, 30));
  assert.equal(url.pathname, "/nmsapi/v1/notams");
  assert.equal(url.searchParams.get("radius"), "26");
});

test("NMS fetch mints a token, sends GEOJSON, and reuses the token", async () => {
  resetNmsTokenCache();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/auth/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: "1799" }), { status: 200 });
    }
    return new Response(JSON.stringify(nmsBody), { status: 200 });
  }) as typeof fetch;
  try {
    const cfg = nmsConfig({ FAA_NMS_CLIENT_ID: "id", FAA_NMS_CLIENT_SECRET: "secret" })!;
    const ctx = { lat: 39.0997, lon: -94.5786, radiusMiles: 30, env: {} };
    const rows = await fetchNmsNotams(cfg, ctx, 1_000_000);
    await fetchNmsNotams(cfg, ctx, 1_000_000 + 60_000);
    assert.equal(rows.length, 1);
    const tokenCalls = calls.filter((c) => c.url.endsWith("/v1/auth/token"));
    assert.equal(tokenCalls.length, 1);
    const tokenHeaders = new Headers(tokenCalls[0].init?.headers);
    assert.equal(tokenHeaders.get("authorization"), `Basic ${btoa("id:secret")}`);
    assert.equal(tokenCalls[0].init?.body, "grant_type=client_credentials");
    const notamHeaders = new Headers(calls[1].init?.headers);
    assert.equal(notamHeaders.get("authorization"), "Bearer tok");
    assert.equal(notamHeaders.get("nmsResponseFormat"), "GEOJSON");
  } finally {
    globalThis.fetch = realFetch;
    resetNmsTokenCache();
  }
});

test("NOTAM is a polled source and is listed once", () => {
  assert.ok(sourceNames().includes("NOTAM"));
  assert.equal(knownSourceNames().filter((n) => n === "NOTAM").length, 1);
});
