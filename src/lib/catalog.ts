import { createServerFn } from "@tanstack/react-start";
import { SOURCES, type SourceId } from "@/lib/addon";
import type { SearchHit, TitleKind } from "@/lib/search";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type CatalogSourceStat = {
  id: SourceId;
  name: string;
  count: number;
  lastFetchedAt: string | null;
  lastOk: boolean | null;
  lastMs: number | null;
  note: string | null;
  inserted: number;
  updated: number;
  indexUrl: string;
};

export type CatalogStats = {
  total: number;
  lastFetchedAt: string | null;
  engine: "mongodb" | "postgres";
  database: string;
  sources: CatalogSourceStat[];
};

export type FetchReport = {
  id: SourceId;
  name: string;
  ok: boolean;
  count: number;
  inserted: number;
  updated: number;
  ms: number;
  note: string | null;
  indexUrl: string;
};

function decodeEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCharCode(Number(num)))
    .replace(/&/g, "&")
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value: string) {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function yearFrom(text: string): number | null {
  const match = text.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  return match ? Number(match[1]) : null;
}

function kindFrom(text: string): TitleKind {
  return /season|series|s\d{2}|k-drama|episode|സീസൺ|സീസണ്/i.test(text)
    ? "series"
    : "movie";
}

function titleFromSlug(slug: string) {
  const year = yearFrom(slug);
  const base = slug.replace(/-(?:19|20)\d{2}$/, "").replace(/-/g, " ").trim();
  const titled = base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return {
    title: year ? `${titled} (${year})` : titled,
    year,
  };
}

function seasonFrom(text: string): number | null {
  const match = text.match(
    /(?:season|സീസൺ|സീസണ്)[\s._-]*0*(\d{1,2})|\bs0*(\d{1,2})\b/i,
  );
  if (!match) return null;
  const n = Number(match[1] || match[2]);
  return n >= 1 && n <= 40 ? n : null;
}

function seriesTitleFrom(title: string) {
  return title
    .replace(/\s*[–—-]\s*[\u0d00-\u0d7f].*$/u, "")
    .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, "")
    .replace(/(?:season|സീസൺ)\s*0*\d+/gi, "")
    .replace(/\bs0*\d{1,2}\b/gi, "")
    .replace(/[()]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hit(
  partial: Omit<SearchHit, "poster" | "subtitleUrl" | "lastmod" | "season" | "seriesTitle"> &
    Partial<Pick<SearchHit, "poster" | "subtitleUrl" | "lastmod" | "season" | "seriesTitle">>,
): SearchHit {
  const kind = partial.kind;
  const season =
    partial.season ?? seasonFrom(`${partial.title} ${partial.url}`);
  return {
    ...partial,
    poster: partial.poster ?? null,
    subtitleUrl: partial.subtitleUrl ?? null,
    lastmod: partial.lastmod ?? null,
    season: kind === "series" ? season : null,
    seriesTitle:
      kind === "series"
        ? (partial.seriesTitle ?? (seriesTitleFrom(partial.title) || partial.title))
        : null,
  };
}

async function fetchText(url: string, timeoutMs: number) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xml,text/plain;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function parseMsoneArticles(html: string): SearchHit[] {
  const articles = html.match(/<article[\s\S]*?<\/article>/gi) ?? [];
  const hits: SearchHit[] = [];
  for (const article of articles) {
    const href =
      article.match(/href="(https:\/\/malayalamsubtitles\.org\/[^"]+)"/)?.[1] ??
      null;
    if (!href || href.includes("/search/") || href.endsWith("/releases/")) continue;
    const alt = article.match(/alt="([^"]+)"/)?.[1];
    const heading = article.match(
      /<h[12][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i,
    )?.[1];
    const title = stripTags(alt || heading || "");
    if (!title) continue;
    const poster =
      article.match(
        /src="(https:\/\/malayalamsubtitles\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
      )?.[1] ?? null;
    const series =
      /release-type-series|category-series|season/i.test(article) ||
      kindFrom(title) === "series";
    hits.push(
      hit({
        title,
        url: href,
        year: yearFrom(title),
        kind: series ? "series" : "movie",
        poster,
      }),
    );
  }
  return hits;
}

function parseMsoneSitemap(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const block of xml.split("<url>").slice(1)) {
    const loc = block.match(
      /<loc>(https:\/\/malayalamsubtitles\.org\/languages\/[^<]+)<\/loc>/,
    )?.[1];
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    const slug = loc.replace(/\/$/, "").split("/").pop() ?? "";
    if (!slug) continue;
    const { title, year } = titleFromSlug(slug);
    const poster =
      block.match(
        /<image:loc>(https:\/\/malayalamsubtitles\.org\/[^<]+)<\/image:loc>/,
      )?.[1] ?? null;
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? null;
    hits.push(hit({ title, url: loc, year, kind: kindFrom(slug), poster, lastmod }));
  }
  return hits;
}

function parseGoatCatalog(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re =
    /<a href="(\/release\/[^"]+)"[^>]*>\s*<h5 class="card-title name[^"]*">([\s\S]*?)<\/h5>/gi;
  for (const match of html.matchAll(re)) {
    const path = match[1];
    const title = stripTags(match[2] ?? "");
    if (!title || seen.has(path)) continue;
    seen.add(path);
    hits.push(
      hit({
        title,
        url: `https://malayalamsubtitles.in${path}`,
        year: yearFrom(title) ?? yearFrom(path),
        kind: kindFrom(`${title} ${path}`),
      }),
    );
  }
  return hits;
}

function parseMmMarkdown(markdown: string): SearchHit[] {
  const skip = new Set([
    "about-us",
    "fest",
    "filter",
    "submission",
    "status",
    "enquiry",
    "subtitles",
    "advanced-filter",
    "freshers-submission",
  ]);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re =
    /\[([^\]]{3,160})\]\((https:\/\/moviemirrorsubtitles\.com\/([^)/]+)\/)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(re)) {
    const rawTitle = stripTags(match[1] ?? "").replace(/\s*#####.*$/, "");
    const url = match[2];
    const slug = match[3] ?? "";
    if (
      !rawTitle ||
      seen.has(url) ||
      skip.has(slug) ||
      slug.startsWith("category") ||
      /^(download|search search|back to home)$/i.test(rawTitle) ||
      rawTitle.includes("Language")
    ) {
      continue;
    }
    seen.add(url);
    hits.push(
      hit({
        title: rawTitle.slice(0, 140),
        url,
        year: yearFrom(rawTitle) ?? yearFrom(slug),
        kind: kindFrom(`${rawTitle} ${slug}`),
      }),
    );
  }
  return hits;
}

function parseGenericSitemap(xml: string, host: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const block of xml.split("<url>").slice(1)) {
    const loc = block.match(/<loc>(https?:\/\/[^<]+)<\/loc>/)?.[1];
    if (!loc || seen.has(loc) || !loc.includes(host)) continue;
    const path = loc.replace(/https?:\/\/[^/]+/, "");
    if (
      path === "/" ||
      /\/(category|tag|page|about|contact|feed|wp-)/i.test(path)
    ) {
      continue;
    }
    const slug = loc.replace(/\/$/, "").split("/").pop() ?? "";
    if (!slug || slug.endsWith(".xml")) continue;
    seen.add(loc);
    const { title, year } = titleFromSlug(slug);
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? null;
    hits.push(hit({ title, url: loc, year, kind: kindFrom(slug), lastmod }));
  }
  return hits;
}

async function loadMmSeed(): Promise<SearchHit[]> {
  try {
    const mod = (await import("@/lib/data/mm-catalog.json")).default as Array<
      Omit<SearchHit, "poster" | "subtitleUrl"> & {
        poster?: string | null;
        subtitleUrl?: string | null;
      }
    >;
    return (Array.isArray(mod) ? mod : []).map((row) =>
      hit({
        ...row,
        poster: row.poster ?? null,
        subtitleUrl: row.subtitleUrl ?? null,
      }),
    );
  } catch {
    return [];
  }
}

async function collectMsone(): Promise<{
  items: SearchHit[];
  note: string | null;
  ok: boolean;
}> {
  try {
    const index = await fetchText(
      "https://malayalamsubtitles.org/sitemap_index.xml",
      8000,
    );
    const maps = [
      ...new Set(
        (index.text.match(
          /https:\/\/malayalamsubtitles\.org\/post-sitemap\d*\.xml/g,
        ) ?? []) as string[],
      ),
    ];
    if (maps.length === 0) {
      maps.push(
        "https://malayalamsubtitles.org/post-sitemap.xml",
        "https://malayalamsubtitles.org/post-sitemap2.xml",
        "https://malayalamsubtitles.org/post-sitemap3.xml",
        "https://malayalamsubtitles.org/post-sitemap4.xml",
      );
    }
    const pages = await Promise.all(
      maps.map((url) =>
        fetchText(url, 12000).catch(() => ({ ok: false, status: 0, text: "" })),
      ),
    );
    const fromMaps = pages.flatMap((page) => parseMsoneSitemap(page.text));
    const recent = await fetchText(
      "https://malayalamsubtitles.org/releases/",
      8000,
    );
    const fromRecent = parseMsoneArticles(recent.text);
    const byUrl = new Map<string, SearchHit>();
    for (const item of [...fromMaps, ...fromRecent]) byUrl.set(item.url, item);
    const items = [...byUrl.values()];
    return {
      items,
      ok: items.length > 0,
      note: items.length
        ? `Sitemap index · ${maps.length} post maps`
        : "MSone sitemap returned no titles",
    };
  } catch {
    return { items: [], ok: false, note: "MSone sitemap fetch failed" };
  }
}

async function collectGoat(): Promise<{
  items: SearchHit[];
  note: string | null;
  ok: boolean;
}> {
  try {
    const { text } = await fetchText(
      "https://malayalamsubtitles.in/search-and-download/",
      8000,
    );
    const items = parseGoatCatalog(text);
    return {
      items,
      ok: items.length > 0,
      note: items.length
        ? "HTML catalog index (no XML sitemap published)"
        : "Team GOAT catalog was empty",
    };
  } catch {
    return { items: [], ok: false, note: "Team GOAT index fetch failed" };
  }
}

async function collectMm(): Promise<{
  items: SearchHit[];
  note: string | null;
  ok: boolean;
}> {
  const seed = await loadMmSeed();
  try {
    const sitemap = await fetchText(
      "https://moviemirrorsubtitles.com/sitemap.xml",
      8000,
    );
    if (sitemap.ok && sitemap.text.includes("<url>")) {
      const items = parseGenericSitemap(
        sitemap.text,
        "moviemirrorsubtitles.com",
      );
      if (items.length > 40) {
        return { items, ok: true, note: "XML sitemap" };
      }
    }
  } catch {
    // bot wall
  }

  try {
    const { text } = await fetchText(
      "https://r.jina.ai/https://moviemirrorsubtitles.com/subtitles/",
      9000,
    );
    const live = parseMmMarkdown(text);
    if (live.length > 40) {
      return { items: live, ok: true, note: "Listing index via reader" };
    }
  } catch {
    // seed fallback
  }

  if (seed.length > 0) {
    return {
      items: seed,
      ok: true,
      note: "Movie Mirror sitemap is bot-walled; stored listing snapshot",
    };
  }
  return {
    items: [],
    ok: false,
    note: "Movie Mirror is bot-protected from this host",
  };
}

export const catalogStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogStats> => {
    const store = await import("@/lib/catalog-store");
    const { total, bySource } = await store.countTitles();
    const fetches = await store.latestFetches();
    const fetchMap = new Map<string, (typeof fetches)[number]>();
    for (const row of fetches) {
      if (!fetchMap.has(row.sourceId)) fetchMap.set(row.sourceId, row);
    }
    const sources = SOURCES.map((source) => {
      const fetch = fetchMap.get(source.id);
      return {
        id: source.id,
        name: source.name,
        count: bySource.get(source.id) ?? 0,
        lastFetchedAt: fetch?.fetchedAt ?? null,
        lastOk: fetch ? fetch.ok : null,
        lastMs: fetch?.ms ?? null,
        note: fetch?.note ?? null,
        inserted: fetch?.inserted ?? 0,
        updated: fetch?.updated ?? 0,
        indexUrl: source.indexUrl,
      };
    });
    return {
      total,
      lastFetchedAt: fetches[0]?.fetchedAt ?? null,
      engine: store.catalogEngine(),
      database: store.catalogEngine() === "mongodb" ? "MALsub" : "local",
      sources,
    };
  },
);

export async function runCatalogFetch(): Promise<{
  fetchedAt: string;
  engine: "mongodb" | "postgres";
  sources: FetchReport[];
}> {
  const store = await import("@/lib/catalog-store");
  const collectors: Record<
    SourceId,
    () => Promise<{ items: SearchHit[]; note: string | null; ok: boolean }>
  > = {
    msone: collectMsone,
    "movie-mirror": collectMm,
    "team-goat": collectGoat,
  };

  const reports = await Promise.all(
    SOURCES.map(async (source) => {
      const started = Date.now();
      try {
        const { items, note, ok } = await collectors[source.id]();
        const counts =
          items.length > 0
            ? await store.upsertTitles(source.id, items)
            : { count: 0, inserted: 0, updated: 0 };
        const ms = Date.now() - started;
        await store.recordFetch({
          sourceId: source.id,
          ok,
          count: counts.count,
          inserted: counts.inserted,
          updated: counts.updated,
          note,
          ms,
        });
        return {
          id: source.id,
          name: source.name,
          ok,
          count: counts.count,
          inserted: counts.inserted,
          updated: counts.updated,
          ms,
          note,
          indexUrl: source.indexUrl,
        } satisfies FetchReport;
      } catch {
        const ms = Date.now() - started;
        await store.recordFetch({
          sourceId: source.id,
          ok: false,
          count: 0,
          inserted: 0,
          updated: 0,
          note: "Fetch failed",
          ms,
        });
        return {
          id: source.id,
          name: source.name,
          ok: false,
          count: 0,
          inserted: 0,
          updated: 0,
          ms,
          note: "Fetch failed",
          indexUrl: source.indexUrl,
        } satisfies FetchReport;
      }
    }),
  );

  return {
    fetchedAt: new Date().toISOString(),
    engine: store.catalogEngine(),
    sources: reports,
  };
}

export const fetchCatalogs = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ fetchedAt: string; engine: "mongodb" | "postgres"; sources: FetchReport[] }> => {
    return runCatalogFetch();
  },
);

function scheduleAutofetch() {
  if (typeof window !== "undefined") return;
  const enabled =
    Boolean(process.env.RENDER) || process.env.AUTO_FETCH === "1";
  if (!enabled) return;
  const g = globalThis as typeof globalThis & { __malsubAutoFetch__?: boolean };
  if (g.__malsubAutoFetch__) return;
  g.__malsubAutoFetch__ = true;
  const tick = async () => {
    try {
      await runCatalogFetch();
    } catch (error) {
      console.error("[malsub] autofetch failed", error);
    }
  };
  setTimeout(() => void tick(), 25_000);
  setInterval(() => void tick(), 12 * 60 * 60 * 1000);
}

scheduleAutofetch();

