import { ADDON, SOURCES } from "@/lib/addon";
import { cinemetaByImdb } from "@/lib/cinemeta";
import { scoreHit } from "@/lib/match";
import type { SearchHit, TitleKind } from "@/lib/search";

export type StremioSubtitle = {
  id: string;
  url: string;
  lang: string;
};

function parseResource(path: string) {
  const match = path.match(
    /\/subtitles\/(movie|series)\/(tt\d{7,})(?::(\d+):(\d+))?\.json$/i,
  );
  if (!match) return null;
  return {
    kind: match[1] as TitleKind,
    imdb: match[2],
    season: match[3] ? Number(match[3]) : null,
    episode: match[4] ? Number(match[4]) : null,
  };
}

export function addonManifest(origin: string) {
  const base = origin.replace(/\/$/, "");
  return {
    id: ADDON.id,
    version: ADDON.version,
    name: ADDON.name,
    description: ADDON.description,
    logo: `${base}/addon-logo.svg`,
    resources: ["subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: { adult: false, p2p: false },
  };
}

export async function subtitlesForRequest(origin: string, path: string) {
  const parsed = parseResource(path);
  if (!parsed) return { subtitles: [] as StremioSubtitle[] };

  const meta = await cinemetaByImdb(parsed.imdb, parsed.kind);
  if (!meta) return { subtitles: [] as StremioSubtitle[] };

  const { searchTitles } = await import("@/lib/catalog-store");
  const rows = await searchTitles(meta.name);
  const matches = rows
    .map((row) => ({
      row,
      score: scoreHit(row, meta.name, {
        year: meta.year,
        season: parsed.season,
        kind: parsed.kind,
      }),
    }))
    .filter(({ row, score }) => {
      if (score < 11) return false;
      if (meta.year && row.year && Math.abs(row.year - meta.year) > 1) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const base = origin.replace(/\/$/, "");
  const subtitles: StremioSubtitle[] = matches.map(({ row }) => {
    const source = SOURCES.find((item) => item.id === row.sourceId);
    return {
      id: `${ADDON.id}:${row.sourceId}:${parsed.imdb}:${row.season ?? "m"}`,
      url: `${base}/api/subtitle?u=${encodeURIComponent(row.url)}`,
      lang: "mal",
      name: `${source?.name ?? row.sourceId} · ${row.title}`,
    } as StremioSubtitle;
  });

  return { subtitles };
}

export function pickSearchHitTitle(hit: SearchHit) {
  return hit.seriesTitle || hit.title;
}
