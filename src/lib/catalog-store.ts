import { MONGO_DB_NAME, SOURCES, type SourceId } from "@/lib/addon";
import type { SearchHit, TitleKind } from "@/lib/search";

export type CatalogEngine = "mongodb" | "postgres";

export type CatalogRecord = SearchHit & {
  sourceId: SourceId;
  pageUrl: string;
  subtitleUrl: string | null;
  lastmod: string | null;
};

export type UpsertCounts = {
  count: number;
  inserted: number;
  updated: number;
};

export type FetchRow = {
  sourceId: string;
  fetchedAt: string;
  ok: boolean;
  ms: number;
  note: string | null;
  count: number;
  inserted: number;
  updated: number;
};

type MongoDb = import("mongodb").Db;

const globalRef = globalThis as typeof globalThis & {
  __malsubMongo__?: Promise<MongoDb>;
};

function mongoUri() {
  const raw =
    (typeof process !== "undefined" &&
      (process.env.MONGODB_URI || process.env.MONGO_URL)) ||
    "";
  return raw.trim();
}

export function catalogEngine(): CatalogEngine {
  return mongoUri() ? "mongodb" : "postgres";
}

async function getSqlLazy() {
  const { getSql } = await import("@/lib/db");
  return getSql();
}

async function getMongo(): Promise<MongoDb> {
  if (!globalRef.__malsubMongo__) {
    globalRef.__malsubMongo__ = (async () => {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(mongoUri(), {
        maxPoolSize: 4,
        minPoolSize: 0,
        maxIdleTimeMS: 30_000,
        serverSelectionTimeoutMS: 8000,
      });
      await client.connect();
      const db = client.db(MONGO_DB_NAME);
      const titles = db.collection("titles");
      await titles.createIndex({ sourceId: 1, pageUrl: 1 }, { unique: true });
      await titles.createIndex({ sourceId: 1, seriesTitle: 1, season: 1 });
      return db;
    })().catch((err) => {
      globalRef.__malsubMongo__ = undefined;
      throw err;
    });
  }
  return globalRef.__malsubMongo__;
}

function toHit(row: {
  title: string;
  pageUrl?: string;
  url?: string;
  year: number | null;
  kind: TitleKind | string;
  poster: string | null;
  subtitleUrl?: string | null;
  season?: number | null;
  seriesTitle?: string | null;
  lastmod?: string | null;
}): SearchHit {
  return {
    title: row.title,
    url: row.pageUrl ?? row.url ?? "",
    year: row.year,
    kind: row.kind === "series" ? "series" : "movie",
    poster: row.poster,
    subtitleUrl: row.subtitleUrl ?? null,
    season: typeof row.season === "number" ? row.season : null,
    seriesTitle: row.seriesTitle ?? null,
    lastmod: row.lastmod ?? null,
  };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function countTitles() {
  if (catalogEngine() === "mongodb") {
    const db = await getMongo();
    const total = await db.collection("titles").countDocuments();
    const grouped = await db
      .collection("titles")
      .aggregate<{ _id: string; n: number }>([
        { $group: { _id: "$sourceId", n: { $sum: 1 } } },
      ])
      .toArray();
    return {
      total,
      bySource: new Map(grouped.map((row) => [row._id, row.n])),
    };
  }

  const sql = await getSqlLazy();
  const totalRows = await sql<{ n: number }>`select count(*)::int as n from titles`;
  const grouped = await sql<{ source_id: string; n: number }>`
    select source_id, count(*)::int as n from titles group by source_id
  `;
  return {
    total: totalRows[0]?.n ?? 0,
    bySource: new Map(grouped.map((row) => [row.source_id, row.n])),
  };
}

export async function searchTitles(query: string) {
  const needle = query.trim();
  if (catalogEngine() === "mongodb") {
    const db = await getMongo();
    const rx = { $regex: escapeRegex(needle), $options: "i" };
    const tokens = needle
      .split(/\s+/)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .filter((token) => token.length >= 3);
    const or = [
      { title: rx },
      { pageUrl: rx },
      { seriesTitle: rx },
      ...tokens.map((token) => ({ title: { $regex: token, $options: "i" } })),
    ];
    const rows = await db
      .collection("titles")
      .find({ $or: or })
      .project({
        sourceId: 1,
        title: 1,
        pageUrl: 1,
        year: 1,
        kind: 1,
        poster: 1,
        subtitleUrl: 1,
        season: 1,
        seriesTitle: 1,
        lastmod: 1,
      })
      .sort({ year: -1, title: 1 })
      .toArray();
    return rows.map((row) => ({
      sourceId: row.sourceId as SourceId,
      ...toHit({
        title: String(row.title),
        pageUrl: String(row.pageUrl),
        year: typeof row.year === "number" ? row.year : null,
        kind: String(row.kind),
        poster: typeof row.poster === "string" ? row.poster : null,
        subtitleUrl: typeof row.subtitleUrl === "string" ? row.subtitleUrl : null,
        season: typeof row.season === "number" ? row.season : null,
        seriesTitle: typeof row.seriesTitle === "string" ? row.seriesTitle : null,
        lastmod: typeof row.lastmod === "string" ? row.lastmod : null,
      }),
    }));
  }

  const sql = await getSqlLazy();
  const like = `%${needle.replace(/[%_]/g, " ")}%`;
  const rows = await sql<{
    source_id: SourceId;
    title: string;
    url: string;
    year: number | null;
    kind: TitleKind;
    poster: string | null;
    subtitle_url: string | null;
    season: number | null;
    series_title: string | null;
    lastmod: string | null;
  }>`
    select source_id, title, url, year, kind, poster, subtitle_url, season, series_title, lastmod
    from titles
    where title ilike ${like}
       or url ilike ${like}
       or coalesce(series_title, '') ilike ${like}
    order by year desc nulls last, title asc
  `;
  return rows.map((row) => ({
    sourceId: row.source_id,
    ...toHit({
      title: row.title,
      pageUrl: row.url,
      year: row.year,
      kind: row.kind,
      poster: row.poster,
      subtitleUrl: row.subtitle_url,
      season: row.season,
      seriesTitle: row.series_title,
      lastmod: row.lastmod,
    }),
  }));
}

export async function upsertTitles(
  sourceId: SourceId,
  items: SearchHit[],
): Promise<UpsertCounts> {
  if (items.length === 0) return { count: 0, inserted: 0, updated: 0 };

  if (catalogEngine() === "mongodb") {
    const db = await getMongo();
    const now = new Date();
    const ops = items.map((hit) => ({
      updateOne: {
        filter: { sourceId, pageUrl: hit.url },
        update: {
          $set: {
            sourceId,
            title: hit.title,
            pageUrl: hit.url,
            subtitleUrl: hit.subtitleUrl ?? null,
            year: hit.year,
            kind: hit.kind,
            poster: hit.poster,
            lastmod: hit.lastmod ?? null,
            season: hit.season ?? null,
            seriesTitle: hit.seriesTitle ?? null,
            fetchedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    }));
    const result = { upsertedCount: 0, modifiedCount: 0 };
    for (let i = 0; i < ops.length; i += 500) {
      const chunk = await db
        .collection("titles")
        .bulkWrite(ops.slice(i, i + 500), { ordered: false });
      result.upsertedCount += chunk.upsertedCount;
      result.modifiedCount += chunk.modifiedCount;
    }
    const inserted = result.upsertedCount;
    const updated = result.modifiedCount;
    return { count: items.length, inserted, updated };
  }

  const sql = await getSqlLazy();
  const existingRows = await sql<{ url: string }>`
    select url from titles where source_id = ${sourceId}
  `;
  const existing = new Set(existingRows.map((row) => row.url));
  let inserted = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < items.length; i += 40) {
    const chunk = items.slice(i, i + 40);
    const params: unknown[] = [];
    const values = chunk.map((hit, index) => {
      if (!existing.has(hit.url)) inserted += 1;
      const b = index * 11;
      params.push(
        sourceId,
        hit.title,
        hit.url,
        hit.year,
        hit.kind,
        hit.poster,
        hit.subtitleUrl ?? null,
        hit.lastmod ?? null,
        hit.season ?? null,
        hit.seriesTitle ?? null,
        now,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11}::timestamptz)`;
    });
    await sql.query(
      `insert into titles (source_id, title, url, year, kind, poster, subtitle_url, lastmod, season, series_title, fetched_at)
       values ${values.join(",")}
       on conflict (source_id, url) do update set
         title = excluded.title,
         year = excluded.year,
         kind = excluded.kind,
         poster = excluded.poster,
         subtitle_url = excluded.subtitle_url,
         lastmod = excluded.lastmod,
         season = excluded.season,
         series_title = excluded.series_title,
         fetched_at = excluded.fetched_at`,
      params,
    );
  }

  return {
    count: items.length,
    inserted,
    updated: items.length - inserted,
  };
}

export async function recordFetch(row: {
  sourceId: SourceId;
  ok: boolean;
  count: number;
  inserted: number;
  updated: number;
  note: string | null;
  ms: number;
}) {
  if (catalogEngine() === "mongodb") {
    const db = await getMongo();
    await db.collection("fetches").insertOne({
      sourceId: row.sourceId,
      ok: row.ok,
      count: row.count,
      inserted: row.inserted,
      updated: row.updated,
      note: row.note,
      ms: row.ms,
      fetchedAt: new Date(),
    });
    return;
  }

  const sql = await getSqlLazy();
  await sql`
    insert into catalog_fetches (source_id, ok, count, inserted, updated, note, ms)
    values (
      ${row.sourceId},
      ${row.ok},
      ${row.count},
      ${row.inserted},
      ${row.updated},
      ${row.note},
      ${row.ms}
    )
  `;
}

export async function latestFetches(): Promise<FetchRow[]> {
  if (catalogEngine() === "mongodb") {
    const db = await getMongo();
    const rows = await db
      .collection("fetches")
      .find({})
      .sort({ fetchedAt: -1 })
      .limit(30)
      .toArray();
    return rows.map((row) => ({
      sourceId: String(row.sourceId),
      fetchedAt:
        row.fetchedAt instanceof Date
          ? row.fetchedAt.toISOString()
          : String(row.fetchedAt ?? ""),
      ok: Boolean(row.ok),
      ms: Number(row.ms ?? 0),
      note: typeof row.note === "string" ? row.note : null,
      count: Number(row.count ?? 0),
      inserted: Number(row.inserted ?? 0),
      updated: Number(row.updated ?? 0),
    }));
  }

  const sql = await getSqlLazy();
  return sql<{
    source_id: string;
    fetched_at: string;
    ok: boolean;
    ms: number;
    note: string | null;
    count: number;
    inserted: number;
    updated: number;
  }>`
    select source_id, fetched_at::text as fetched_at, ok, ms, note,
           count, inserted, updated
    from catalog_fetches
    order by fetched_at desc
    limit 30
  `.then((rows) =>
    rows.map((row) => ({
      sourceId: row.source_id,
      fetchedAt: row.fetched_at,
      ok: row.ok,
      ms: row.ms,
      note: row.note,
      count: row.count,
      inserted: row.inserted,
      updated: row.updated,
    })),
  );
}

export function sourceMeta(id: SourceId) {
  return SOURCES.find((source) => source.id === id)!;
}
