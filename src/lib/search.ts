import { createServerFn } from "@tanstack/react-start";
import { SOURCES, type SourceId } from "@/lib/addon";
import type { CinemetaTitle } from "@/lib/cinemeta";

export type TitleKind = "movie" | "series";

export type SearchHit = {
  title: string;
  url: string;
  year: number | null;
  kind: TitleKind;
  poster: string | null;
  subtitleUrl?: string | null;
  lastmod?: string | null;
  season?: number | null;
  seriesTitle?: string | null;
};

export type SourceSearchResult = {
  id: SourceId;
  name: string;
  ok: boolean;
  ms: number;
  total: number;
  searchUrl: string;
  results: SearchHit[];
  note: string | null;
};

const MAX_RESULTS = 8;

const SEARCH_URL: Record<SourceId, (query: string) => string> = {
  msone: (query) =>
    `https://malayalamsubtitles.org/?s=${encodeURIComponent(query)}`,
  "movie-mirror": () => "https://moviemirrorsubtitles.com/subtitles/",
  "team-goat": () => "https://malayalamsubtitles.in/search-and-download/",
};

export const searchCatalog = createServerFn({ method: "POST" })
  .validator((data: { query: string }) => ({
    query: String(data?.query ?? "")
      .trim()
      .slice(0, 80),
  }))
  .handler(async ({ data }) => {
    const query = data.query;
    if (query.length < 2) {
      return {
        query,
        resolved: null as CinemetaTitle | null,
        sources: [] as SourceSearchResult[],
        catalogEmpty: false,
      };
    }

    const [{ countTitles, searchTitles }, { searchCinemeta }, { scoreHit }] =
      await Promise.all([
        import("@/lib/catalog-store"),
        import("@/lib/cinemeta"),
        import("@/lib/match"),
      ]);

    const started = Date.now();
    const [{ total }, cine] = await Promise.all([
      countTitles(),
      searchCinemeta(query).catch(() => [] as CinemetaTitle[]),
    ]);
    const catalogEmpty = total === 0;
    const resolved = cine[0] ?? null;
    const rows = catalogEmpty ? [] : await searchTitles(query);
    const ranked = rows
      .map((row) => ({
        row,
        score: Math.max(
          scoreHit(row, query, {
            year: resolved?.year,
            kind: resolved?.kind,
          }),
          ...cine.slice(0, 4).map((meta) =>
            scoreHit(row, meta.name, { year: meta.year, kind: meta.kind }),
          ),
        ),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || (b.row.year ?? 0) - (a.row.year ?? 0));

    const ms = Date.now() - started;
    const grouped = new Map<SourceId, SearchHit[]>();
    for (const { row } of ranked) {
      const list = grouped.get(row.sourceId) ?? [];
      list.push({
        title: row.title,
        url: row.url,
        year: row.year,
        kind: row.kind,
        poster: row.poster ?? resolved?.poster ?? null,
        subtitleUrl: row.subtitleUrl ?? null,
        season: row.season ?? null,
        seriesTitle: row.seriesTitle ?? null,
        lastmod: row.lastmod ?? null,
      });
      grouped.set(row.sourceId, list);
    }

    const sources: SourceSearchResult[] = SOURCES.map((source) => {
      const all = grouped.get(source.id) ?? [];
      return {
        id: source.id,
        name: source.name,
        ok: !catalogEmpty,
        ms,
        total: all.length,
        searchUrl: SEARCH_URL[source.id](query),
        results: all.slice(0, MAX_RESULTS),
        note: catalogEmpty
          ? "Database is empty. Fetch catalogs from Admin first."
          : all.length === 0 && resolved
            ? `Cinemeta resolved “${resolved.name}” (${resolved.year ?? "—"}) — not in this source yet.`
            : null,
      };
    });

    return { query, resolved, sources, catalogEmpty };
  });
