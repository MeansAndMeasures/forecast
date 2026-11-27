import { AnySource } from "./types";
import { metarSource } from "./metar";
import { airnowSource } from "./airnow";
import { firmsSource } from "./firms";
import { hrrrSmokeSource } from "./hrrr_smoke";
import { nexradSource } from "./nexrad";
import { nldnSource } from "./nldn";
import { eventsSource } from "./events";
import { nwsAlertsSource } from "./nws_alerts";
import { notamSource } from "./notam";

/**
 * Every source the tick polls. NOTAM is polled from the FAA NMS API (enabled by
 * FAA_NMS_CLIENT_ID / FAA_NMS_CLIENT_SECRET); POST /ingest/notam still accepts
 * pushed batches from the optional SWIM relay into the same NOTAM snapshots.
 */
export const registry: AnySource[] = [
  metarSource,
  airnowSource,
  firmsSource,
  hrrrSmokeSource,
  nexradSource,
  nldnSource,
  eventsSource,
  nwsAlertsSource,
  notamSource,
];

export const NOTAM_SOURCE_NAME = "NOTAM";

export function sourceNames(): string[] {
  return registry.map((s) => s.name);
}

/**
 * Names of sources that can have stored snapshots: the polled registry plus
 * anything that can also arrive by push (NOTAM, via /ingest/notam).
 */
export function knownSourceNames(): string[] {
  return [...new Set([...sourceNames(), NOTAM_SOURCE_NAME])];
}

export function findSource(name: string): AnySource | undefined {
  return registry.find((s) => s.name === name);
}
