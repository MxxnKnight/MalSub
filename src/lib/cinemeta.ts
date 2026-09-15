import type { TitleKind } from "@/lib/search";

export type CinemetaTitle = {
  imdb: string;
  name: string;
  year: number | null;
  kind: TitleKind;
  poster: string | null;
};

async function getJson(url: string, timeoutMs = 4000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Cinemeta ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

function yearOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "");
  const match = text.match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function fromMeta(raw: Record<string, unknown>, fallbackKind: TitleKind): CinemetaTitle | null {
  const imdb = String(raw.imdb_id ?? raw.id ?? "");
  const name = String(raw.name ?? "").trim();
  if (!imdb.startsWith("tt") || !name) return null;
  const kind: TitleKind = raw.type === "series" ? "series" : fallbackKind;
  return {
    imdb,
    name,
    year: yearOf(raw.year ?? raw.releaseInfo),
    kind,
    poster: typeof raw.poster === "string" ? raw.poster : null,
  };
}

export async function searchCinemeta(query: string): Promise<CinemetaTitle[]> {
  const q = encodeURIComponent(query.trim());
  if (q.length < 2) return [];
  const urls = [
    `https://v3-cinemeta.strem.io/catalog/movie/top/search=${q}.json`,
    `https://v3-cinemeta.strem.io/catalog/series/top/search=${q}.json`,
  ];
  const pages = await Promise.allSettled(urls.map((url) => getJson(url)));
  const seen = new Set<string>();
  const out: CinemetaTitle[] = [];
  pages.forEach((page, index) => {
    if (page.status !== "fulfilled") return;
    const kind: TitleKind = index === 1 ? "series" : "movie";
    const metas = Array.isArray(page.value.metas) ? page.value.metas : [];
    for (const item of metas.slice(0, 8)) {
      if (!item || typeof item !== "object") continue;
      const row = fromMeta(item as Record<string, unknown>, kind);
      if (!row || seen.has(row.imdb)) continue;
      seen.add(row.imdb);
      out.push(row);
    }
  });
  return out;
}

export async function cinemetaByImdb(
  imdb: string,
  kind: TitleKind,
): Promise<CinemetaTitle | null> {
  const id = imdb.replace(/:.*/, "");
  const type = kind === "series" ? "series" : "movie";
  try {
    const data = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`);
    const meta = data.meta;
    if (!meta || typeof meta !== "object") return null;
    return fromMeta(meta as Record<string, unknown>, kind);
  } catch {
    return null;
  }
}
