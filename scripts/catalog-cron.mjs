#!/usr/bin/env node
/**
 * Catalog cron worker for GitHub Actions (and local use).
 * Modes: auto | full | incremental
 * Env: MONGODB_URI (required), MONGO_DB_NAME, CATALOG_MODE
 */

import { MongoClient } from "mongodb";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DB_NAME = process.env.MONGO_DB_NAME || "MALsub";
const MODE = (process.env.CATALOG_MODE || "auto").toLowerCase();
const FULL_THRESHOLD = { msone: 1500, "movie-mirror": 80, "team-goat": 80 };

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&/g, "&")
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(value) {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function yearFrom(text) {
  const match = String(text).match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
  return match ? Number(match[1]) : null;
}

function kindFrom(text) {
  return /season|series|s\d{2}|k-drama|episode/i.test(text) ? "series" : "movie";
}

function titleFromSlug(slug) {
  const year = yearFrom(slug);
  const base = slug.replace(/-(?:19|20)\d{2}$/, "").replace(/-/g, " ").trim();
  const titled = base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return { title: year ? `${titled} (${year})` : titled, year };
}

function seasonFrom(text) {
  const match = String(text).match(/(?:season)[\s._-]*0*(\d{1,2})|\bs0*(\d{1,2})\b/i);
  if (!match) return null;
  const n = Number(match[1] || match[2]);
  return n >= 1 && n <= 40 ? n : null;
}

function seriesTitleFrom(title) {
  return title
    .replace(/\(\s*(?:19|20)\d{2}\s*\)/g, "")
    .replace(/(?:season)\s*0*\d+/gi, "")
    .replace(/\bs0*\d{1,2}\b/gi, "")
    .replace(/[()]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function hit(partial) {
  const kind = partial.kind;
  const season = partial.season ?? seasonFrom(`${partial.title} ${partial.url}`);
  return {
    title: partial.title,
    url: partial.url,
    year: partial.year ?? null,
    kind,
    poster: partial.poster ?? null,
    subtitleUrl: partial.subtitleUrl ?? null,
    lastmod: partial.lastmod ?? null,
    season: kind === "series" ? season : null,
    seriesTitle:
      kind === "series"
        ? partial.seriesTitle ?? (seriesTitleFrom(partial.title) || partial.title)
        : null,
  };
}

function isBlockedBody(text) {
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

async function fetchText(url, timeoutMs = 15000) {
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

async function fetchTextWithFallback(url, timeoutMs = 15000) {
  try {
    const direct = await fetchText(url, timeoutMs);
    if (direct.ok && direct.text.length > 200 && !isBlockedBody(direct.text)) {
      return { ...direct, via: "direct" };
    }
  } catch {}
  try {
    const proxy = await fetchText(`https://r.jina.ai/${url}`, timeoutMs + 5000);
    return { ...proxy, via: "jina" };
  } catch {
    return { ok: false, status: 0, text: "", via: "failed" };
  }
}

function parseMsoneRss(xml) {
  const hits = [];
  for (const block of xml.split("<item>").slice(1)) {
    const rawTitle =
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] ??
      block.match(/<title>([^<]*)<\/title>/)?.[1] ??
      "";
    const title = stripTags(rawTitle);
    const link = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim();
    if (!title || !link || !link.includes("malayalamsubtitles.org")) continue;
    hits.push(
      hit({
        title,
        url: link,
        year: yearFrom(title) ?? yearFrom(link),
        kind: kindFrom(`${title} ${link}`),
      }),
    );
  }
  return hits;
}

function parseMsoneArticles(html) {
  const articles = html.match(/<article[\s\S]*?<\/article>/gi) ?? [];
  const hits = [];
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
  if (hits.length === 0) {
    const seen = new Set();
    for (const loc of html.match(
      /https:\/\/malayalamsubtitles\.org\/languages\/[a-z0-9\-./]+/gi,
    ) ?? []) {
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

function parseMsoneSitemap(xml) {
  const hits = [];
  const seen = new Set();
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

function parseGoatCatalog(html) {
  const hits = [];
  const seen = new Set();
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
        year: yearFrom(title),
        kind: kindFrom(title),
      }),
    );
  }
  return hits;
}

function parseGenericSitemap(xml, host) {
  const hits = [];
  const seen = new Set();
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

function parseMmMarkdown(markdown) {
  const hits = [];
  const seen = new Set();
  const re = /\[([^\]]+)\]\((https?:\/\/moviemirrorsubtitles\.com\/[^)]+)\)/gi;
  for (const match of markdown.matchAll(re)) {
    const title = stripTags(match[1] ?? "");
    const url = match[2];
    if (!title || !url || seen.has(url)) continue;
    if (/\/(category|tag|page)\//i.test(url)) continue;
    seen.add(url);
    hits.push(
      hit({
        title,
        url,
        year: yearFrom(title) ?? yearFrom(url),
        kind: kindFrom(`${title} ${url}`),
      }),
    );
  }
  return hits;
}

async function collectMsone(effective) {
  const byUrl = new Map();
  const sources = [];
  try {
    const feed = await fetchText("https://malayalamsubtitles.org/feed/", 15000);
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
      const res = await fetchText(url, 15000);
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
        15000,
      );
      const maps = [
        ...new Set(
          index.text.match(/https:\/\/malayalamsubtitles\.org\/post-sitemap\d*\.xml/g) ?? [],
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
      const pages = await Promise.all(maps.map((url) => fetchTextWithFallback(url, 25000)));
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
  const items = [...byUrl.values()];
  return {
    items,
    ok: items.length > 0,
    note: items.length
      ? `MSone · ${effective} · ${sources.join(" + ") || "mixed"}`
      : "MSone blocked (Cloudflare) from this runner",
  };
}

async function collectGoat() {
  try {
    const page = await fetchTextWithFallback(
      "https://malayalamsubtitles.in/search-and-download/",
      15000,
    );
    const items = parseGoatCatalog(page.text);
    return {
      items,
      ok: items.length > 0,
      note: items.length
        ? `HTML catalog${page.via === "jina" ? " · via proxy" : ""}`
        : "Team GOAT catalog empty",
    };
  } catch {
    return { items: [], ok: false, note: "Team GOAT fetch failed" };
  }
}

async function collectMm() {
  try {
    const sitemap = await fetchTextWithFallback(
      "https://moviemirrorsubtitles.com/sitemap.xml",
      15000,
    );
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
    const { text } = await fetchText(
      "https://r.jina.ai/https://moviemirrorsubtitles.com/subtitles/",
      15000,
    );
    const live = parseMmMarkdown(text);
    if (live.length > 40) {
      return { items: live, ok: true, note: "Listing index via reader" };
    }
  } catch {}
  return { items: [], ok: false, note: "Movie Mirror blocked from this runner" };
}

async function countBySource(db) {
  const rows = await db
    .collection("titles")
    .aggregate([{ $group: { _id: "$sourceId", n: { $sum: 1 } } }])
    .toArray();
  const map = new Map();
  for (const row of rows) map.set(row._id, row.n);
  return map;
}

async function upsertTitles(db, sourceId, items) {
  if (!items.length) return { count: 0, inserted: 0, updated: 0 };
  const now = new Date();
  const ops = items.map((h) => ({
    updateOne: {
      filter: { sourceId, pageUrl: h.url },
      update: {
        $set: {
          sourceId,
          title: h.title,
          pageUrl: h.url,
          subtitleUrl: h.subtitleUrl ?? null,
          year: h.year,
          kind: h.kind,
          poster: h.poster,
          lastmod: h.lastmod ?? null,
          season: h.season ?? null,
          seriesTitle: h.seriesTitle ?? null,
          fetchedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsert: true,
    },
  }));
  let upsertedCount = 0;
  let modifiedCount = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const chunk = await db.collection("titles").bulkWrite(ops.slice(i, i + 500), { ordered: false });
    upsertedCount += chunk.upsertedCount;
    modifiedCount += chunk.modifiedCount;
  }
  return { count: items.length, inserted: upsertedCount, updated: modifiedCount };
}

async function recordFetch(db, row) {
  await db.collection("catalog_fetches").insertOne({
    sourceId: row.sourceId,
    ok: row.ok,
    count: row.count,
    inserted: row.inserted,
    updated: row.updated,
    note: row.note,
    ms: row.ms,
    fetchedAt: new Date(),
  });
}

async function main() {
  const uri = (process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
  if (!uri) {
    console.error("MONGODB_URI is required");
    process.exit(1);
  }
  const client = new MongoClient(uri, { maxPoolSize: 4, serverSelectionTimeoutMS: 12000 });
  await client.connect();
  const db = client.db(DB_NAME);
  await db.collection("titles").createIndex({ sourceId: 1, pageUrl: 1 }, { unique: true });
  const bySource = await countBySource(db);
  console.log("[catalog-cron] existing counts", Object.fromEntries(bySource));
  console.log("[catalog-cron] mode", MODE);
  const sources = [
    { id: "msone", name: "MSone", run: async (effective) => collectMsone(effective) },
    { id: "movie-mirror", name: "Movie Mirror", run: async () => collectMm() },
    { id: "team-goat", name: "Team GOAT", run: async () => collectGoat() },
  ];
  const reports = [];
  for (const source of sources) {
    const started = Date.now();
    const existing = bySource.get(source.id) ?? 0;
    const threshold = FULL_THRESHOLD[source.id] ?? 100;
    const effective =
      MODE === "full" || MODE === "incremental"
        ? MODE
        : existing < threshold
          ? "full"
          : "incremental";
    console.log(`[catalog-cron] ${source.id} → ${effective} (have ${existing})`);
    try {
      const { items, note, ok } = await source.run(effective);
      const counts =
        items.length > 0
          ? await upsertTitles(db, source.id, items)
          : { count: 0, inserted: 0, updated: 0 };
      const ms = Date.now() - started;
      const report = {
        sourceId: source.id,
        name: source.name,
        ok,
        count: counts.count,
        inserted: counts.inserted,
        updated: counts.updated,
        note,
        ms,
        mode: effective,
      };
      await recordFetch(db, report);
      reports.push(report);
      console.log(
        `[catalog-cron] ${source.id}: ok=${ok} read=${counts.count} new=${counts.inserted} upd=${counts.updated} ${ms}ms — ${note}`,
      );
    } catch (err) {
      const ms = Date.now() - started;
      const report = {
        sourceId: source.id,
        name: source.name,
        ok: false,
        count: 0,
        inserted: 0,
        updated: 0,
        note: `Fetch failed: ${err?.message || err}`,
        ms,
        mode: effective,
      };
      await recordFetch(db, report).catch(() => {});
      reports.push(report);
      console.error(`[catalog-cron] ${source.id} failed`, err);
    }
  }
  await client.close();
  console.log("[catalog-cron] done", JSON.stringify({ fetchedAt: new Date().toISOString(), reports }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
