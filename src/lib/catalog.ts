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

/** full = sitemaps + deep pages; incremental = RSS + recent releases only */
export type CatalogFetchMode = "auto" | "full" | "incremental";

function decodeEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCharCode(Number(num)))
    .replace(/&/g, "&")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
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
  return /season|series|s\d{2}|k-drama|episode/i.test(text) ? "series" : "movie";
}

function titleFromSlug(slug: string) {
  const year = yearFrom(slug);
  const base = slug.replace(/-(?:19|20)\d{2}$/, "").replace(/-/g, " ").trim();
  const titled = base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { title: year ? `${titled} (${year})` : titled, year };
}

function seasonFrom(text: string): number | null {
  const match = text.match(/(?:season)[\s._-]*0*(\d{1,2})|\bs0*(\d{1,2})\b/i);
  if (!match) return null;
  const n = Number(match[1] || match[2]);
  return n >= 1 && n <= 40 ? n : null;
}

function seriesTitleFrom(title: string) {
  return title
    .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, "")
    .replace(/(?:season)\s*0*\d+/gi, "")
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
  const season = partial.season ?? seasonFrom(`${partial.title} ${partial.url}`);
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
      Accept: "application/xml,text/xml,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function fetchTextWithFallback(url: string, timeoutMs: number) {
  try {
    const direct = await fetchText(url, timeoutMs);
    if (direct.ok && direct.text.length > 200 && !isBlockedBody(direct.text)) {
      return { ...direct, via: "direct" as const };
    }
  } catch {}
  try {
    const proxy = await fetchText(`https://r.jina.ai/${url}`, timeoutMs + 4000);
    return { ...proxy, via: "jina" as const };
  } catch {
    return { ok: false, status: 0, text: "", via: "failed" as const };
  }
}

function isBlockedBody(text: string) {
  const head = text.slice(0, 800).toLowerCase();
  return (
    head.includes("just a moment") ||
    head.includes("cf-browser-verification") ||
    head.includes("attention required") ||
    head.includes("access denied") ||
    (head.includes("cloudflare") &&
      !head.includes("<urlset") &&
      !head.includes("<sitemapindex") &&
      !head.includes("<rss"))
  );
}

function parseMsoneArticles(html: string): SearchHit[] {
  const articles = html.match(/<article[\s\S]*?<\/article>/gi) ?? [];
  const hits: SearchHit[] = [];
  for (const article of articles) {
    const href =
      article.match(/href="(https:\/\/malayalamsubtitles\.org\/[^"]+)"/)?.[1] ?? null;
    if (!href || href.includes("/search/") || href.endsWith("/releases/")) continue;
    const alt = article.match(/alt="([^"]+)"/)?.[1];
    const heading = article.match(/<h[12][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1];
    const title = stripTags(alt || heading || "");
    if (!title) continue;
    const poster =
      article.match(
        /src="(https:\/\/malayalamsubtitles\.org\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
      )?.[1] ?? null;
    const series =
      /release-type-series|category-series|season/i.test(article) || kindFrom(title) === "series";
    hits.push(hit({ title, url: href, year: yearFrom(title), kind: series ? "series" : "movie", poster }));
  }
  if (hits.length === 0) {
    const seen = new Set<string>();
    for (const loc of html.match(/https:\/\/malayalamsubtitles\.org\/languages\/[a-z0-9\-./]+/gi) ?? []) {
      const clean = loc.replace(/[),.]+$/, "");
      if (seen.has(clean)) continue;
      seen.add(clean);
      const slug = clean.replace(/\/$/, "").split("/").pop() ?? "";
      if (!slug) continue;
      const { title, year } = titleFromSlug(slug);
      hits.push(hit({ title, url: clean, year, kind: kindFrom(slug) }));
    }
  }
  return hits;
}

function parseMsoneRss(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const block of xml.split("<item>").slice(1)) {
    const rawTitle =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ??
      block.match(/<title>([^<]*)<\/title>/)?.[1] ??
      "";
    const title = stripTags(rawTitle);
    const link = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
    if (!title || !link || !link.includes("malayalamsubtitles.org")) continue;
    hits.push(hit({ title, url: link, year: yearFrom(title) ?? yearFrom(link), kind: kindFrom(`${title} ${link}`) }));
  }
  return hits;
}

function parseMsoneSitemap(xml: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const block of xml.split("<url>").slice(1)) {
    const loc = block.match(/<loc>(https:\/\/malayalamsubtitles\.org\/languages\/[^<]+)<\/loc>/)?.[1];
    if (!loc || seen.has(loc)) continue;
    seen.add(loc);
    const slug = loc.replace(/\/$/, "").split("/").pop() ?? "";
    if (!slug) continue;
    const { title, year } = titleFromSlug(slug);
    const poster =
      block.match(/<image:loc>(https:\/\/malayalamsubtitles\.org\/[^<]+)<\/image:loc>/)?.[1] ?? null;
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? null;
    hits.push(hit({ title, url: loc, year, kind: kindFrom(slug), poster, lastmod }));
  }
  return hits;
}

function parseGoatCatalog(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /<a href="(\/release\/[^"]+)"[^>]*>\s*<h5 class="card-title name[^"]*">([\s\S]*?)<\/h5>/gi;
  for (const match of html.matchAll(re)) {
    const path = match[1];
    const title = stripTags(match[2] ?? "");
    if (!title || seen.has(path)) continue;
    seen.add(path);
    hits.push(hit({ title, url: `https://malayalamsubtitles.in${path}`, year: yearFrom(title), kind: kindFrom(title) }));
  }
  return hits;
}

function parseMmMarkdown(markdown: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]+)\]\((https?:\/\/moviemirrorsubtitles\.com\/[^)]+)\)/gi;
  for (const match of markdown.matchAll(re)) {
    const title = stripTags(match[1] ?? "");
    const url = match[2];
    if (!title || !url || seen.has(url)) continue;
    if (/\/(category|tag|page)\//i.test(url)) continue;
    seen.add(url);
    hits.push(hit({ title, url, year: yearFrom(title) ?? yearFrom(url), kind: kindFrom(`${title} ${url}`) }));
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
    if (path === "/" || /\/(category|tag|page|about|contact|feed|wp-)/i.test(path)) continue;
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
      Omit<SearchHit, "poster" | "subtitleUrl"> & { poster?: string | null; subtitleUrl?: string | null }
    >;
    return (Array.isArray(mod) ? mod : []).map((row) =>
      hit({ ...row, poster: row.poster ?? null, subtitleUrl: row.subtitleUrl ?? null }),
    );
  } catch {
    return [];
  }
}

async function loadMsoneSeed(): Promise<SearchHit[]> {
  try {
    const { MSONE_SEED_PATHS } = await import("@/lib/data/msone-seed");
    const hits: SearchHit[] = [];
    for (const path of MSONE_SEED_PATHS) {
      const slug = path.split("/").pop() ?? "";
      if (!slug) continue;
      const { title, year } = titleFromSlug(slug);
      hits.push(
        hit({
          title,
          url: `https://malayalamsubtitles.org/languages/${path.replace(/\/$/, "")}/`,
          year,
          kind: kindFrom(path),
        }),
      );
    }
    return hits;
  } catch {
    return [];
  }
}

async function collectMsone(
  mode: CatalogFetchMode = "auto",
  existingCount = 0,
): Promise<{ items: SearchHit[]; note: string | null; ok: boolean }> {
  const byUrl = new Map<string, SearchHit>();
  const sources: string[] = [];
  const effective: "full" | "incremental" =
    mode === "auto" ? (existingCount < 1500 ? "full" : "incremental") : mode;

  try {
    const feed = await fetchText("https://malayalamsubtitles.org/feed/", 12000);
    if (feed.ok && !isBlockedBody(feed.text)) {
      const rss = parseMsoneRss(feed.text);
      for (const item of rss) byUrl.set(item.url, item);
      if (rss.length) sources.push(`rss:${rss.length}`);
    }
  } catch {}

  const maxPages = effective === "full" ? 30 : 5;
  let releaseHits = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const url =
      page === 1
        ? "https://malayalamsubtitles.org/releases/"
        : `https://malayalamsubtitles.org/releases/page/${page}/`;
    try {
      const res = await fetchText(url, 12000);
      if (!res.ok || isBlockedBody(res.text)) break;
      const batch = parseMsoneArticles(res.text);
      if (batch.length === 0) break;
      for (const item of batch) {
        if (!byUrl.has(item.url)) {
          byUrl.set(item.url, item);
          releaseHits += 1;
        }
      }
    } catch {
      break;
    }
  }
  if (releaseHits) sources.push(`releases:${releaseHits}`);

  if (effective === "full" || byUrl.size < 200) {
    try {
      const index = await fetchTextWithFallback(
        "https://malayalamsubtitles.org/sitemap_index.xml",
        12000,
      );
      const maps = [
        ...new Set(
          (index.text.match(/https:\/\/malayalamsubtitles\.org\/post-sitemap\d*\.xml/g) ?? []) as string[],
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
      const pages = await Promise.all(maps.map((url) => fetchTextWithFallback(url, 20000)));
      let mapHits = 0;
      for (const page of pages) {
        for (const item of parseMsoneSitemap(page.text)) {
          if (!byUrl.has(item.url)) {
            byUrl.set(item.url, item);
            mapHits += 1;
          }
        }
      }
      if (mapHits) sources.push(`sitemap:${mapHits}`);
    } catch {}
  }

  if (byUrl.size < 100) {
    const seed = await loadMsoneSeed();
    let added = 0;
    for (const item of seed) {
      if (!byUrl.has(item.url)) {
        byUrl.set(item.url, item);
        added += 1;
      }
    }
    if (added) sources.push(`seed:${added}`);
  }

  const items = [...byUrl.values()];
  return {
    items,
    ok: items.length > 0,
    note: items.length
      ? `MSone · ${effective} · ${sources.join(" + ") || "mixed"}`
      : "MSone blocked (Cloudflare 403) and seed missing",
  };
}

async function collectGoat(): Promise<{ items: SearchHit[]; note: string | null; ok: boolean }> {
  try {
    const page = await fetchTextWithFallback("https://malayalamsubtitles.in/search-and-download/", 12000);
    const items = parseGoatCatalog(page.text);
    return {
      items,
      ok: items.length > 0,
      note: items.length
        ? `HTML catalog index${page.via === "jina" ? " · via proxy" : ""}`
        : "Team GOAT catalog was empty",
    };
  } catch {
    return { items: [], ok: false, note: "Team GOAT index fetch failed" };
  }
}

async function collectMm(): Promise<{ items: SearchHit[]; note: string | null; ok: boolean }> {
  const seed = await loadMmSeed();
  try {
    const sitemap = await fetchTextWithFallback("https://moviemirrorsubtitles.com/sitemap.xml", 12000);
    if (sitemap.ok && (sitemap.text.includes("<url>") || sitemap.text.includes("http"))) {
      const items = parseGenericSitemap(sitemap.text, "moviemirrorsubtitles.com");
      if (items.length > 40) {
        return {
          items,
          ok: true,
          note: sitemap.via === "jina" ? "XML sitemap · via proxy" : "XML sitemap",
        };
      }
    }
  } catch {}
  try {
    const { text } = await fetchText("https://r.jina.ai/https://moviemirrorsubtitles.com/subtitles/", 12000);
    const live = parseMmMarkdown(text);
    if (live.length > 40) return { items: live, ok: true, note: "Listing index via reader" };
  } catch {}
  if (seed.length > 0) {
    return { items: seed, ok: true, note: "Movie Mirror sitemap is bot-walled; stored listing snapshot" };
  }
  return { items: [], ok: false, note: "Movie Mirror is bot-protected from this host" };
}

export const catalogStats = createServerFn({ method: "GET" }).handler(async (): Promise<CatalogStats> => {
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
});

export async function runCatalogFetch(
  mode: CatalogFetchMode = "auto",
): Promise<{ fetchedAt: string; engine: "mongodb" | "postgres"; sources: FetchReport[] }> {
  const store = await import("@/lib/catalog-store");
  const { bySource } = await store.countTitles();
  const collectors: Record<
    SourceId,
    () => Promise<{ items: SearchHit[]; note: string | null; ok: boolean }>
  > = {
    msone: () => collectMsone(mode, bySource.get("msone") ?? 0),
    "movie-mirror": collectMm,
    "team-goat": collectGoat,
  };

  const reports = await Promise.all(
    SOURCES.map(async (source) => {
      const started = Date.now();
      try {
        const { items, note, ok } = await collectors[source.id]();
        const counts =
          items.length > 0 ? await store.upsertTitles(source.id, items) : { count: 0, inserted: 0, updated: 0 };
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

  return { fetchedAt: new Date().toISOString(), engine: store.catalogEngine(), sources: reports };
}

export const fetchCatalogs = createServerFn({ method: "POST" })
  .validator((data: { mode?: string } | undefined) => {
    const raw = String(data?.mode ?? "auto").toLowerCase();
    const mode: CatalogFetchMode =
      raw === "full" || raw === "incremental" || raw === "auto" ? raw : "auto";
    return { mode };
  })
  .handler(async ({ data }): Promise<{ fetchedAt: string; engine: "mongodb" | "postgres"; sources: FetchReport[] }> => {
    return runCatalogFetch(data.mode);
  });

function scheduleAutofetch() {
  if (typeof window !== "undefined") return;
  const enabled = Boolean(process.env.RENDER) || process.env.AUTO_FETCH === "1";
  if (!enabled) return;
  const g = globalThis as typeof globalThis & { __malsubAutoFetch__?: boolean };
  if (g.__malsubAutoFetch__) return;
  g.__malsubAutoFetch__ = true;
  const tick = async () => {
    try {
      await runCatalogFetch("auto");
    } catch (error) {
      console.error("[malsub] autofetch failed", error);
    }
  };
  setTimeout(() => void tick(), 25_000);
  setInterval(() => void tick(), 12 * 60 * 60 * 1000);
}

scheduleAutofetch();
