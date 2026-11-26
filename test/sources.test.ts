import { test } from "node:test";
import assert from "node:assert/strict";
import { metarBbox } from "../src/sources/metar";
import { airnowReadings, airnowUrl, parseAirNowBody } from "../src/sources/airnow";
import { newestVolume } from "../src/sources/nexrad";

test("METAR bbox is rounded to four decimals", () => {
  const bbox = metarBbox(39.0997, -94.5786, 30);
  for (const part of bbox.split(",")) assert.match(part, /^-?\d+\.\d{4}$/);
  const [south, west, north, east] = bbox.split(",").map(Number);
  assert.ok(south < 39.0997 && north > 39.0997 && west < -94.5786 && east > -94.5786);
});

test("AirNow uses the current ziplatlong service", () => {
  const url = new URL(airnowUrl(39.0997, -94.5786, "k"));
  assert.equal(url.pathname, "/aq/observation/current/ziplatlong/");
  assert.equal(url.searchParams.get("latitude"), "39.0997");
  assert.equal(url.searchParams.has("distance"), false);
});

test("AirNow current rows are stored as sent and read like legacy rows", () => {
  const current = [
    {
      dateObserved: "2026-11-26",
      hourObserved: "14:00",
      localTimeZone: "CST",
      reportingAreaName: "Kansas City",
      siteName: "JFK Community Center",
      parameterName: "OZONE",
      nowcastAQI: 31,
      aqiCategoryName: "Good",
    },
    { dateObserved: "11/26/2026", hourObserved: 14, reportingAreaName: "Kansas City", parameterName: "PM2.5", nowcastAQI: 62 },
  ];
  const rows = parseAirNowBody(current);
  assert.deepEqual(rows, current, "upstream field names are kept");
  const readings = airnowReadings(rows);
  assert.deepEqual(
    { p: readings[0].parameter, aqi: readings[0].aqi, h: readings[0].hour, area: readings[0].area, cat: readings[0].category },
    { p: "O3", aqi: 31, h: 14, area: "Kansas City", cat: { Number: 1, Name: "Good" } },
  );
  assert.equal(readings[1].date, "2026-11-26");
  assert.deepEqual(readings[1].category, { Number: 2, Name: "Moderate" });
});

test("AirNow legacy rows still read, and rows without a value are skipped", () => {
  const legacy = {
    DateObserved: "2026-09-01 ",
    HourObserved: 9,
    LocalTimeZone: "CST",
    ReportingArea: "Kansas City",
    StateCode: "MO",
    Latitude: 39.1,
    Longitude: -94.6,
    ParameterName: "PM2.5",
    AQI: 45,
    Category: { Number: 1, Name: "Good" },
  };
  const readings = airnowReadings(parseAirNowBody([legacy, { ...legacy, AQI: -1 }]));
  assert.equal(readings.length, 1);
  assert.equal(readings[0].state, "MO");
  assert.equal(readings[0].date, "2026-09-01");
  assert.throws(() => parseAirNowBody([{ siteName: "no reading" }]), /not recognized/);
});

test("AirNow's empty envelope is empty, its retirement notice is an error", () => {
  assert.deepEqual(parseAirNowBody({ WebServiceError: [{ Message: "No data found for the given location." }] }), []);
  assert.throws(
    () => parseAirNowBody({ WebServiceError: [{ Message: "This web service has been retired as of October 1, 2026." }] }),
    /retired/,
  );
});

test("NEXRAD picks the newest volume, not the first of the day", () => {
  const xml = `<ListBucketResult>
    <Contents><Key>2026/11/26/KEAX/KEAX20261126_000412_V06</Key><LastModified>2026-11-26T00:05:01.000Z</LastModified></Contents>
    <Contents><Key>2026/11/26/KEAX/KEAX20261126_141902_V06</Key><LastModified>2026-11-26T14:20:00.000Z</LastModified></Contents>
    <Contents><Key>2026/11/26/KEAX/KEAX20261126_141902_V06_MDM</Key><LastModified>2026-11-26T14:20:05.000Z</LastModified></Contents>
  </ListBucketResult>`;
  const v = newestVolume("KEAX", xml);
  assert.equal(v?.s3_key, "2026/11/26/KEAX/KEAX20261126_141902_V06");
  assert.equal(v?.ts, Date.parse("2026-11-26T14:20:00.000Z") / 1000);
  assert.equal(newestVolume("KEAX", "<ListBucketResult></ListBucketResult>"), undefined);
});
