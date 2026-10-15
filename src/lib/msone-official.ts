/**
 * Relay for MSone's official Stremio addon (addon.malayalamsubtitles.org).
 *
 * Why this exists: malayalamsubtitles.org article pages (/languages/...) are
 * behind a Cloudflare "managed challenge" that no server can pass, so we can
 * no longer scrape post pages for their ?wpdmdl= download links. Their own
 * addon server does that lookup internally and hands out signed,
 * directly-downloadable subtitle URLs — we just relay them.
 *
 * Endpoint: GET https://addon.malayalamsubtitles.org/subtitles/{movie|series}/{imdb}[:season:episode].json
 * Response: { subtitles: [{ id, url, lang: "mal", label }] }
 *   - movie urls:  https://malayalamsubtitles.org/?wpdmdl=<id>&source=nuvio&imdb_id=<tt>&type=movie&sig=<sig>
 *   - series urls: https://addon.malayalamsubtitles.org/subfiles/<tt>/s<season>/<file>.srt?e=1&pid=<n>&tot=<n>&sig=<sig>
 * Unknown titles return { subtitles: [] }. Signatures are stable across
 * requests, but we still re-fetch on a short TTL to stay polite and fresh.
 *
 * URL canonicalization: for movies we strip everything down to the bare
 * ?wpdmdl=<id> endpoint. That is their public download URL (the same one
 * their own website's download button uses), it needs no signature, and it
 * is served by the main domain — so it keeps working even if their addon
 * server goes down, and it can't break from signature rotation. (Verified:
 * bare ?wpdmdl= works; a tampered sig 403s, so never forward a bad sig.)
 * Series /subfiles/ URLs can't be stripped (404 without a valid sig) and
 * stay dependent on their addon server.
 */

const OFFICIAL_BASE = "https://addon.malayalamsubtitles.org";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type MsoneOfficialSubtitle = {
  id: string;
  url: string;
  lang: string;
  label: string;
};

// Short in-memory cache: polite to their server, signatures stay fresh.
const cache = new Map<string, { at: number; value: MsoneOfficialSubtitle[] }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Canonicalize a relay URL to its most durable form.
 * Movies: strip to the bare ?wpdmdl=<id> public download endpoint.
 * Series: /subfiles/ URLs require a valid sig — keep as-is.
 */
export function canonicalMsoneFileUrl(url: string): string {
  try {
    const u = new URL(url);
    const wpdmdl = u.searchParams.get("wpdmdl");
    if (
      wpdmdl &&
      /^\d+$/.test(wpdmdl) &&
      u.hostname === "malayalamsubtitles.org"
    ) {
      return `https://malayalamsubtitles.org/?wpdmdl=${wpdmdl}`;
    }
  } catch {
    // fall through and return the original
  }
  return url;
}

export function msoneOfficialCacheSize(): number {
  return cache.size;
}

export async function fetchMsoneOfficial(
  kind: "movie" | "series",
  imdb: string,
  season?: number | null,
  episode?: number | null,
): Promise<MsoneOfficialSubtitle[]> {
  let resource = `/subtitles/${kind}/${imdb}`;
  if (kind === "series" && season && episode) {
    resource += `:${season}:${episode}`;
  }
  const cached = cache.get(resource);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const res = await fetch(`${OFFICIAL_BASE}${resource}.json`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { subtitles?: unknown };
    const list = Array.isArray(data.subtitles) ? data.subtitles : [];
    const clean: MsoneOfficialSubtitle[] = [];
    for (const item of list) {
      const s = item as Partial<MsoneOfficialSubtitle>;
      if (s && typeof s.url === "string" && s.url.startsWith("http")) {
        clean.push({
          id: typeof s.id === "string" ? s.id : `${imdb}-${clean.length}`,
          url: canonicalMsoneFileUrl(s.url),
          lang: typeof s.lang === "string" ? s.lang : "mal",
          label: typeof s.label === "string" ? s.label : imdb,
        });
      }
    }
    cache.set(resource, { at: Date.now(), value: clean });
    // Bound the cache so one busy server can't grow it forever.
    if (cache.size > 500) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    return clean;
  } catch {
    // Fail open: their server down/blocked => just no MSone relay results.
    return [];
  }
}
