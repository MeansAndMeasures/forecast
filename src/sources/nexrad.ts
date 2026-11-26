import { z } from "zod";
import { Source, SourceContext } from "./types";

const NexradObservationSchema = z.object({
  station: z.string(),
  ts: z.number(),
  vcp: z.number().optional(),
  s3_key: z.string(),
});

const NexradResponseSchema = z.array(NexradObservationSchema);

export type NexradObservation = z.infer<typeof NexradObservationSchema>;

export const nexradSource: Source<NexradObservation> = {
  name: "NEXRAD",
  cadenceMs: 10 * 60 * 1000,
  schema: NexradResponseSchema,
  isEnabled(ctx: SourceContext) {
    return Boolean(ctx.env.NEXRAD_STATIONS);
  },
  async fetch(ctx: SourceContext) {
    const stations = (ctx.env.NEXRAD_STATIONS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const results: NexradObservation[] = [];
    const failures: string[] = [];
    const now = new Date();
    for (const station of stations) {
      try {
        // Volumes are keyed by UTC day. Just after midnight today's prefix is
        // still empty, so fall back to yesterday's.
        const latest =
          (await latestVolume(station, now)) ??
          (await latestVolume(station, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
        if (latest) results.push(latest);
      } catch (err) {
        failures.push(`${station}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Every station failing is an outage, not an empty radar picture.
    if (stations.length > 0 && failures.length === stations.length) {
      throw new Error(`NEXRAD listing failed: ${failures.join("; ")}`);
    }
    const parsed = NexradResponseSchema.safeParse(results);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.format(), null, 2));
    }
    return parsed.data;
  },
  observedAt(data) {
    if (data.length === 0) return { min: 0, max: 0 };
    const times = data.map((o) => o.ts);
    return { min: Math.min(...times), max: Math.max(...times) };
  },
};

export function dayPrefix(station: string, day: Date): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}/${station}/`;
}

/**
 * Newest Level II volume in an S3 ListObjectsV2 page. S3 lists keys in
 * ascending order, so the newest is the last one; `_MDM` sidecar files are not
 * volumes.
 */
export function newestVolume(station: string, xml: string): NexradObservation | undefined {
  const entries = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
    .map((m) => ({
      key: m[1].match(/<Key>([^<]+)<\/Key>/)?.[1],
      lastModified: m[1].match(/<LastModified>([^<]+)<\/LastModified>/)?.[1],
    }))
    .filter((e): e is { key: string; lastModified: string } => Boolean(e.key && e.lastModified) && !e.key!.endsWith("_MDM"));
  const last = entries[entries.length - 1];
  if (!last) return undefined;
  const ts = Math.floor(new Date(last.lastModified).getTime() / 1000);
  if (!Number.isFinite(ts)) return undefined;
  return { station, ts, s3_key: last.key };
}

async function latestVolume(station: string, day: Date): Promise<NexradObservation | undefined> {
  // A station writes roughly 150–300 volumes a day, inside one 1000-key page.
  const url = `https://unidata-nexrad-level2.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(dayPrefix(station, day))}&max-keys=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return newestVolume(station, await res.text());
}
