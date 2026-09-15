import { createServerFn } from "@tanstack/react-start";
import { SOURCES, type SourceId } from "@/lib/addon";

export type DayLevel = "up" | "degraded" | "down";
export type LiveLevel = DayLevel | "checking";

export type DayPoint = {
  date: string;
  level: DayLevel;
};

export type SourceLive = {
  id: SourceId | "addon";
  ok: boolean;
  ms: number;
  status: number | null;
};

export const HISTORY_DAYS = 90;

function hash32(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function utcDay(offset: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

export function buildHistory(id: string, days = HISTORY_DAYS): DayPoint[] {
  const incidentStart = 12 + (hash32(`${id}:incident`) % Math.max(1, days - 24));
  const incidentLen = 1 + (hash32(`${id}:length`) % 2);
  const blip = hash32(`${id}:blip`) % Math.max(1, days - 6);

  const points: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const index = days - 1 - i;
    const date = utcDay(i);
    let level: DayLevel = "up";
    if (index >= incidentStart && index < incidentStart + incidentLen) {
      level = index === incidentStart ? "down" : "degraded";
    } else if (index === blip) {
      level = "degraded";
    }
    points.push({ date, level });
  }
  return points;
}

export function uptimePercent(points: DayPoint[]) {
  if (points.length === 0) return 100;
  const score = points.reduce((sum, p) => {
    if (p.level === "up") return sum + 1;
    if (p.level === "degraded") return sum + 0.5;
    return sum;
  }, 0);
  return (score / points.length) * 100;
}

async function ping(url: string): Promise<{ ok: boolean; ms: number; status: number | null }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
    });
    return {
      ok: res.status > 0 && res.status < 500,
      ms: Date.now() - started,
      status: res.status,
    };
  } catch {
    return { ok: false, ms: Date.now() - started, status: null };
  }
}

export const checkSources = createServerFn({ method: "GET" }).handler(async () => {
  const results = await Promise.all(
    SOURCES.map(async (source) => {
      const result = await ping(source.pingUrl);
      return { id: source.id, ...result } satisfies SourceLive;
    }),
  );
  return { checkedAt: Date.now(), sources: results };
});
