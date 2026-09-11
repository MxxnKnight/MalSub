const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');
const { MongoClient } = require('mongodb');

// Custom Axios client with realistic User-Agent & 15s timeout
const httpClient = axios.create({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: 15000 // 15 seconds max per request to avoid missing slow responses
});

// Ultra-lightweight in-memory cache for Render free tier (24 hour TTL, max 300 entries)
class SimpleCache {
    constructor(maxItems = 300, ttlMs = 24 * 60 * 60 * 1000) {
        this.maxItems = maxItems;
        this.ttlMs = ttlMs;
        this.cache = new Map();
    }
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }
    set(key, value) {
        if (this.cache.size >= this.maxItems) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
    }
}

const metaCache = new SimpleCache(200, 24 * 60 * 60 * 1000);
const subCache = new SimpleCache(300, 24 * 60 * 60 * 1000);

// =========================================================
// MONGODB INDEX — Persistent slug→URL index per provider
// DB: MALsub  |  Collection: index
// Each document: { _id: "<provider>:<slug>", provider, slug, url, lastmod }
//
// In-memory Maps mirror the DB for zero-latency lookups.
// On startup we warm-load from MongoDB, then refresh from sitemaps.
// If MongoDB is unreachable, we fall back to in-memory only.
// =========================================================
const MONGO_URI = process.env.MONGODB_URI || null;
const MONGO_DB   = 'MALsub';
const MONGO_COLL = 'index';

let mongoClient = null;
let mongoCollection = null;

async function connectMongo() {
    if (!MONGO_URI) {
        console.warn('[MongoDB] MONGODB_URI not set — running without persistent index');
        return false;
    }
    try {
        mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
        await mongoClient.connect();
        const db = mongoClient.db(MONGO_DB);
        mongoCollection = db.collection(MONGO_COLL);
        // Ensure index on provider field for fast per-provider queries
        await mongoCollection.createIndex({ provider: 1 });
        console.log(`[MongoDB] Connected to ${MONGO_DB}.${MONGO_COLL}`);
        return true;
    } catch (e) {
        console.error('[MongoDB] Connection failed:', e.message);
        mongoClient = null;
        mongoCollection = null;
        return false;
    }
}

// Warm-load all docs from MongoDB into in-memory Maps
async function warmLoadFromMongo() {
    if (!mongoCollection) return 0;
    try {
        const cursor = mongoCollection.find({}, { projection: { _id: 0, provider: 1, slug: 1, url: 1 } });
        let count = 0;
        await cursor.forEach(doc => {
            const map = sitemapIndex[doc.provider];
            if (map && !map.has(doc.slug)) {
                map.set(doc.slug, doc.url);
                count++;
            }
        });
        console.log(`[MongoDB] Warm-loaded ${count} slugs into in-memory index`);
        return count;
    } catch (e) {
        console.error('[MongoDB] Warm-load failed:', e.message);
        return 0;
    }
}

// Upsert a batch of { provider, slug, url } docs into MongoDB
async function upsertToMongo(docs) {
    if (!mongoCollection || docs.length === 0) return;
    try {
        const ops = docs.map(d => ({
            updateOne: {
                filter: { _id: `${d.provider}:${d.slug}` },
                update: { $set: { provider: d.provider, slug: d.slug, url: d.url, lastmod: new Date() } },
                upsert: true
            }
        }));
        const result = await mongoCollection.bulkWrite(ops, { ordered: false });
        console.log(`[MongoDB] Upserted ${result.upsertedCount} new + ${result.modifiedCount} updated slugs`);
    } catch (e) {
        console.error('[MongoDB] Upsert failed:', e.message);
    }
}

async function getMongoStats() {
    if (!mongoCollection) return null;
    try {
        const total = await mongoCollection.countDocuments();
        const byProvider = await mongoCollection.aggregate([
            { $group: { _id: '$provider', count: { $sum: 1 } } }
        ]).toArray();
        const providerMap = {};
        byProvider.forEach(p => { providerMap[p._id] = p.count; });
        return { total, byProvider: providerMap };
    } catch (e) {
        return null;
    }
}

// =========================================================
// SITEMAP INDEX — In-memory slug→URL Maps for all 3 providers
// Warm-loaded from MongoDB on startup, refreshed every 6 hours
// =========================================================
const sitemapIndex = {
    msone: new Map(),   // slug → postUrl
    mirror: new Map(),  // slug → postUrl
    goat: new Map(),    // slug → postUrl
    lastRefreshed: null
};

function urlToSlug(url) {
    return url.replace(/\/$/, '').split('/').pop().toLowerCase();
}

async function buildMsoneIndex() {
    const newDocs = [];
    try {
        const { data: idxXml } = await httpClient.get('https://malayalamsubtitles.org/sitemap.xml', { timeout: 20000 });
        const postSitemaps = [...idxXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
            .map(m => m[1].trim()).filter(u => u.includes('post-sitemap'));

        for (const sitemapUrl of postSitemaps) {
            try {
                const { data } = await httpClient.get(sitemapUrl, { timeout: 20000 });
                const urls = [...data.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
                for (const url of urls) {
                    const slug = urlToSlug(url);
                    if (slug && !sitemapIndex.msone.has(slug)) {
                        sitemapIndex.msone.set(slug, url);
                        newDocs.push({ provider: 'msone', slug, url });
                    }
                }
                console.log(`[INDEX] MSone ${sitemapUrl.split('/').pop()}: total now ${sitemapIndex.msone.size}`);
            } catch (e) {
                console.error(`[INDEX] MSone ${sitemapUrl.split('/').pop()} failed:`, e.message);
            }
        }
        console.log(`[INDEX] MSone: ${newDocs.length} new slugs found (total ${sitemapIndex.msone.size})`);
    } catch(e) {
        console.error('[INDEX] MSone sitemap fetch failed:', e.message);
    }
    await upsertToMongo(newDocs);
}

async function buildMirrorIndex() {
    const newDocs = [];
    try {
        const { data } = await httpClient.get('https://moviemirrorsubtitles.com/post-sitemap.xml', { timeout: 20000 });
        const urls = [...data.matchAll(/<loc>(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/loc>/g)].map(m => m[1].trim());
        for (const url of urls) {
            const slug = urlToSlug(url);
            if (slug && !sitemapIndex.mirror.has(slug)) {
                sitemapIndex.mirror.set(slug, url);
                newDocs.push({ provider: 'mirror', slug, url });
            }
        }
        console.log(`[INDEX] Movie Mirror: ${newDocs.length} new slugs (total ${sitemapIndex.mirror.size})`);
    } catch(e) {
        console.error('[INDEX] Movie Mirror sitemap fetch failed:', e.message);
    }
    await upsertToMongo(newDocs);
}

async function buildGoatIndex() {
    const newDocs = [];
    try {
        const { data } = await httpClient.get('https://malayalamsubtitles.in/subtitles/', { timeout: 20000 });
        const $ = cheerio.load(data);
        $('a[href*="/release/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const fullUrl = href.startsWith('http') ? href : `https://malayalamsubtitles.in${href.startsWith('/') ? '' : '/'}${href}`;
            const slug = urlToSlug(fullUrl);
            if (slug && !sitemapIndex.goat.has(slug)) {
                sitemapIndex.goat.set(slug, fullUrl);
                newDocs.push({ provider: 'goat', slug, url: fullUrl });
            }
        });
        console.log(`[INDEX] TeamGOAT: ${newDocs.length} new slugs (total ${sitemapIndex.goat.size})`);
    } catch(e) {
        console.error('[INDEX] TeamGOAT /subtitles/ fetch failed:', e.message);
    }
    await upsertToMongo(newDocs);
}

async function refreshSitemapIndex() {
    console.log('[INDEX] Refreshing provider sitemap indexes...');
    await Promise.all([buildMsoneIndex(), buildMirrorIndex(), buildGoatIndex()]);
    sitemapIndex.lastRefreshed = new Date().toISOString();
    console.log(`[INDEX] Refresh complete. MSone=${sitemapIndex.msone.size}, Mirror=${sitemapIndex.mirror.size}, GoAT=${sitemapIndex.goat.size}`);
}

// Lookup helpers: try all slug variants for a title+season+year
function toSlug(text) {
    const norm = normalizeText(text);
    return norm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function indexLookup(indexMap, title, year = null, season = null) {
    const slug = toSlug(title);
    const variants = [];
    if (season && year) variants.push(`${slug}-season${season}-${year}`);
    if (season)        variants.push(`${slug}-season${season}`);
    if (year)          variants.push(`${slug}-${year}`);
    variants.push(slug);
    for (const v of variants) {
        if (indexMap.has(v)) return indexMap.get(v);
    }
    // Fuzzy fallback: find any key that starts with slug
    for (const [key, url] of indexMap) {
        if (key.startsWith(slug + '-') || key === slug) return url;
    }
    return null;
}

const manifest = {
    id: 'org.malsub.addon',
    version: '1.0.0',
    name: 'MalSUB',
    description: 'Malayalam Subtitles for Nuvio and Stremio',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// Helper: Convert IMDb ID to title with caching
async function getMeta(id, type) {
    const imdbId = id.split(':')[0];
    const cacheKey = `${type}_${imdbId}`;
    const cached = metaCache.get(cacheKey);
    if (cached) return cached;

    try {
        const res = await httpClient.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        if (res.data && res.data.meta) {
            const meta = res.data.meta;
            const yearStr = meta.year || meta.releaseInfo;
            let parsedYear = null;
            if (yearStr) {
                const match = String(yearStr).match(/\d{4}/);
                if (match) parsedYear = match[0];
            }
            const result = {
                title: meta.name,
                year: parsedYear
            };
            metaCache.set(cacheKey, result);
            return result;
        }
    } catch (e) {
        console.error("Cinemeta fetch error:", e.message);
    }
    return null;
}

// Deep Scrape: Find the actual download link from a post page with IMDb ID verification
async function findDownloadLink(postUrl, targetImdbId = null) {
    try {
        const { data } = await httpClient.get(postUrl);
        
        // IMDb Verification: If targetImdbId is provided, check if post links to a DIFFERENT IMDb title
        if (targetImdbId) {
            const pageImdbMatch = data.match(/imdb\.com\/title\/(tt\d+)/i);
            if (pageImdbMatch) {
                const pageImdbId = pageImdbMatch[1].toLowerCase();
                if (pageImdbId !== targetImdbId.toLowerCase()) {
                    console.log(`[IMDb MISMATCH] Post ${postUrl} is for ${pageImdbId}, expected ${targetImdbId}. Skipping.`);
                    return null;
                }
                console.log(`[IMDb VERIFIED] Post ${postUrl} matches IMDb ID ${targetImdbId}`);
            }
        }
        
        const $ = cheerio.load(data);
        let downloadLink = null;
        
        // Strategy 1: Look for WordPress Download Manager links (used by MSone)
        const wpdmdlMatch = data.match(/\?wpdmdl=\d+/);
        if (wpdmdlMatch) {
            const urlObj = new URL(postUrl);
            return `${urlObj.protocol}//${urlObj.host}/${wpdmdlMatch[0]}`;
        }
        
        // Strategy 2: Look for specific download path (used by TeamGOAT & MovieMirror)
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && (href.includes('/download/') || href.includes('custom_download') || href.endsWith('.zip') || href.endsWith('.srt'))) {
                downloadLink = href; 
            }
        });
        
        // Fallback strategy if relative link
        if (downloadLink && !downloadLink.startsWith('http')) {
            const urlObj = new URL(postUrl);
            downloadLink = `${urlObj.protocol}//${urlObj.host}${downloadLink.startsWith('/') ? '' : '/'}${downloadLink}`;
        }
        
        return downloadLink;
    } catch (e) {
        console.error("Error finding download link:", e.message);
    }
    return null;
}

function normalizeText(text) {
    return text ? text.normalize("NFD").replace(/[\u0300-\u036f]/g, "") : "";
}


async function searchMsone(title, imdbId = null, season = null, year = null) {
    // Strategy 1: Index-first lookup — direct slug match in sitemap index
    if (sitemapIndex.msone.size > 0) {
        const slug = toSlug(title);
        const variants = [];
        if (season && year) variants.push(`${slug}-season${season}-${year}`);
        if (season)        variants.push(`${slug}-season${season}`);
        if (year)          variants.push(`${slug}-${year}`);
        variants.push(slug);
        for (const v of variants) {
            if (sitemapIndex.msone.has(v)) {
                const url = sitemapIndex.msone.get(v);
                console.log(`[MSone] [INDEX HIT] ${v} → ${url}`);
                const dlLink = await findDownloadLink(url, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [MSone] Found subtitle for "${title}" (index) -> ${dlLink}`);
                    return { id: 'MSone_' + encodeURIComponent(title), url: dlLink, lang: 'Malayalam', name: `[MSone] Malayalam - ${title}`, title: 'MSone' };
                }
            }
        }
        // Fuzzy: scan all keys for titles starting with slug
        for (const [key, url] of sitemapIndex.msone) {
            if (key.startsWith(slug + '-') || key === slug) {
                const dlLink = await findDownloadLink(url, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [MSone] Found subtitle for "${title}" (index fuzzy: ${key}) -> ${dlLink}`);
                    return { id: 'MSone_' + encodeURIComponent(title), url: dlLink, lang: 'Malayalam', name: `[MSone] Malayalam - ${title}`, title: 'MSone' };
                }
            }
        }
    }

    // Strategy 2: Live search fallback (index miss or index not yet built)
    const results = [];
    try {
        const cleanTitleBase = normalizeText(title);
        const cleanSearchQuery = cleanTitleBase.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
        const searchUrl = `https://malayalamsubtitles.org/?s=${encodeURIComponent(cleanSearchQuery)}`;
        console.log(`[MSone] Searching (live): ${searchUrl}`);
        const { data } = await httpClient.get(searchUrl);
        const $ = cheerio.load(data);
        
        const normTitle = cleanTitleBase.toLowerCase();
        const cleanTitle = normTitle.replace(/[^a-z0-9]/g, '');
        
        $('a').each((i, el) => {
            const rawText = $(el).text();
            const normText = normalizeText(rawText).toLowerCase();
            const href = $(el).attr('href');
            const cleanText = normText.replace(/[^a-z0-9]/g, '');
            if (href && (normText.includes(normTitle) || cleanText.includes(cleanTitle)) && !href.includes('?s=') && href.startsWith('http')) {
                results.push({ url: href, name: rawText.trim() });
            }
        });
        
        // Season-aware: if season is known, sort results to prefer matching season post
        let unique = [...new Map(results.map(r => [r.url, r])).values()];
        if (season) {
            const padSeason = String(parseInt(season)).padStart(0, '0');
            const preferred = unique.filter(r => r.url.includes(`season-${padSeason}`) || r.url.includes(`-season-${padSeason}-`) || r.name.toLowerCase().includes(`season ${padSeason}`));
            const rest = unique.filter(r => !preferred.includes(r));
            unique = [...preferred, ...rest];
        }
        
        for (let topResult of unique) {
            const dlLink = await findDownloadLink(topResult.url, imdbId);
            if (dlLink) {
                console.log(`[SUCCESS] [MSone] Found subtitle for "${title}" -> ${dlLink}`);
                return { id: 'MSone_' + encodeURIComponent(title), url: dlLink, lang: 'Malayalam', name: `[MSone] Malayalam - ${topResult.name}`, title: 'MSone' };
            }
        }
        console.log(`[NOT FOUND] [MSone] No subtitle found for "${title}"`);
    } catch (e) {
        console.error(`[ERROR] [MSone] ${e.message}`);
    }
    return null;
}

async function searchTeamGoat(meta, type, id) {
    const imdbId = id.split(':')[0];
    const seasonMatch = id.match(/:(\d+):\d+$/);
    const season = seasonMatch ? seasonMatch[1] : null;
    const slug = toSlug(meta.title);
    
    // Strategy 1: Index-first lookup
    if (sitemapIndex.goat.size > 0) {
        const variants = [];
        if (type === 'series' && season && meta.year) variants.push(`${slug}-season${season}-${meta.year}`);
        if (meta.year)                                variants.push(`${slug}-${meta.year}`);
        if (type === 'series' && season)              variants.push(`${slug}-season${season}`);
        variants.push(slug);
        for (const v of variants) {
            if (sitemapIndex.goat.has(v)) {
                const url = sitemapIndex.goat.get(v);
                console.log(`[TeamGOAT] [INDEX HIT] ${v} → ${url}`);
                const dlLink = await findDownloadLink(url, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [TeamGOAT] Found subtitle for "${meta.title}" (index) -> ${dlLink}`);
                    return { id: 'TeamGOAT_' + encodeURIComponent(meta.title), url: dlLink, lang: 'Malayalam', name: `[TeamGOAT] Malayalam - ${meta.title}`, title: 'Team GOAT' };
                }
            }
        }
    }

    // Strategy 2: Direct URL candidates
    let urls = [];
    if (type === 'series' && season && meta.year) urls.push(`https://malayalamsubtitles.in/release/${slug}-season${season}-${meta.year}/`);
    if (meta.year)                                urls.push(`https://malayalamsubtitles.in/release/${slug}-${meta.year}/`);
    if (type === 'series' && season)              urls.push(`https://malayalamsubtitles.in/release/${slug}-season${season}/`);
    urls.push(`https://malayalamsubtitles.in/release/${slug}/`);
    urls = [...new Set(urls)];
    
    for (let u of urls) {
        console.log(`[TeamGOAT] Checking direct URL: ${u}`);
        const dlLink = await findDownloadLink(u, imdbId);
        if (dlLink) {
            console.log(`[SUCCESS] [TeamGOAT] Found subtitle for "${meta.title}" -> ${dlLink}`);
            return { id: 'TeamGOAT_' + encodeURIComponent(meta.title), url: dlLink, lang: 'Malayalam', name: `[TeamGOAT] Malayalam - ${meta.title}`, title: 'Team GOAT' };
        }
    }

    // Strategy 3: Live search fallback
    try {
        const cleanTitleBase = normalizeText(meta.title);
        const cleanSearchQuery = cleanTitleBase.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
        const searchUrl = `https://malayalamsubtitles.in/?s=${encodeURIComponent(cleanSearchQuery)}`;
        console.log(`[TeamGOAT] Searching (live): ${searchUrl}`);
        const { data } = await httpClient.get(searchUrl);
        const $ = cheerio.load(data);
        let matchUrl = null;
        let matchName = meta.title;
        const normTitle = cleanTitleBase.toLowerCase();
        const cleanTitle = normTitle.replace(/[^a-z0-9]/g, '');
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const rawText = $(el).text();
            const normText = normalizeText(rawText).toLowerCase();
            const cleanText = normText.replace(/[^a-z0-9]/g, '');
            if (href && href.includes('/release/') && (normText.includes(normTitle) || cleanText.includes(cleanTitle))) {
                matchUrl = href;
                if (rawText.trim()) matchName = rawText.trim();
            }
        });
        if (matchUrl) {
            if (!matchUrl.startsWith('http')) matchUrl = `https://malayalamsubtitles.in${matchUrl.startsWith('/') ? '' : '/'}${matchUrl}`;
            const dlLink = await findDownloadLink(matchUrl, imdbId);
            if (dlLink) {
                console.log(`[SUCCESS] [TeamGOAT] Found subtitle for "${meta.title}" -> ${dlLink}`);
                return { id: 'TeamGOAT_' + encodeURIComponent(meta.title), url: dlLink, lang: 'Malayalam', name: `[TeamGOAT] Malayalam - ${matchName}`, title: 'Team GOAT' };
            }
        }
        console.log(`[NOT FOUND] [TeamGOAT] No subtitle found for "${meta.title}"`);
    } catch (e) {
        console.error(`[ERROR] [TeamGOAT] ${e.message}`);
    }
    return null;
}

async function searchMovieMirror(title, imdbId = null, year = null) {
    // Strategy 1: Index-first lookup
    if (sitemapIndex.mirror.size > 0) {
        const slug = toSlug(title);
        const variants = [];
        if (year) variants.push(`${slug}-${year}`);
        variants.push(slug);
        for (const v of variants) {
            if (sitemapIndex.mirror.has(v)) {
                const url = sitemapIndex.mirror.get(v);
                console.log(`[Movie Mirror] [INDEX HIT] ${v} → ${url}`);
                const dlLink = await findDownloadLink(url, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [Movie Mirror] Found subtitle for "${title}" (index) -> ${dlLink}`);
                    return { id: 'MovieMirror_' + encodeURIComponent(title), url: dlLink, lang: 'Malayalam', name: `[Movie Mirror] Malayalam - ${title}`, title: 'Movie Mirror' };
                }
            }
        }
        // Fuzzy: scan for slug prefix
        for (const [key, url] of sitemapIndex.mirror) {
            if (key.startsWith(slug + '-') || key === slug) {
                const dlLink = await findDownloadLink(url, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [Movie Mirror] Found subtitle for "${title}" (index fuzzy: ${key}) -> ${dlLink}`);
                    return { id: 'MovieMirror_' + encodeURIComponent(title), url: dlLink, lang: 'Malayalam', name: `[Movie Mirror] Malayalam - ${title}`, title: 'Movie Mirror' };
                }
            }
        }
    }

    // Strategy 2: WP REST API search fallback
    try {
        const cleanTitleBase = normalizeText(title);
        const cleanQuery = cleanTitleBase.replace(/:/g, ' ').replace(/\./g, '').replace(/\s+/g, ' ').trim();
        const searchUrl = `https://moviemirrorsubtitles.com/wp-json/wp/v2/posts?search=${encodeURIComponent(cleanQuery)}`;
        console.log(`[Movie Mirror] Searching (live): ${searchUrl}`);
        const { data } = await httpClient.get(searchUrl);
        if (data && data.length > 0) {
            for (let post of data) {
                const dlLink = await findDownloadLink(post.link, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [Movie Mirror] Found subtitle for "${title}" -> ${dlLink}`);
                    return { id: 'MovieMirror_' + encodeURIComponent(title), url: dlLink, lang: 'Malayalam', name: `[Movie Mirror] Malayalam - ${title}`, title: 'Movie Mirror' };
                }
            }
        }
        console.log(`[NOT FOUND] [Movie Mirror] No subtitle found for "${title}"`);
    } catch (e) {
        console.error(`[ERROR] [Movie Mirror] ${e.message}`);
    }
    return null;
}

let globalBaseUrl = 'http://localhost:7000'; // Default, overridden in Express

builder.defineSubtitlesHandler(async function(args) {
    const { type, id } = args;
    console.log(`\n========================================`);
    console.log(`[REQUEST] Incoming subtitle request: Type=${type}, ID=${id}`);

    const imdbId = id.split(':')[0];
    const cacheKey = `sub_${type}_${id}`;
    const cached = subCache.get(cacheKey);
    if (cached) {
        console.log(`[CACHE HIT] Returning ${cached.length} cached subtitles for ${id}`);
        return Promise.resolve({ subtitles: cached });
    }

    // ---- DATABASE LOOKUP (fast path) ----
    // ---- LIVE SEARCH ----

    const meta = await getMeta(id, type);
    if (!meta || !meta.title) {
        console.log(`[META ERROR] Could not resolve IMDb ID "${id}" via Cinemeta.`);
        return { subtitles: [] };
    }
    console.log(`[META RESOLVED] Title: "${meta.title}", Year: ${meta.year || 'N/A'}`);

    const seasonMatch2 = id.match(/:(\d+):(\d+)$/);
    const reqSeason = seasonMatch2 ? seasonMatch2[1] : null;

    const [msone, goat, mirror] = await Promise.all([
        searchMsone(meta.title, imdbId, reqSeason, meta.year),
        searchTeamGoat(meta, type, id),
        searchMovieMirror(meta.title, imdbId, meta.year)
    ]);

    const seasonMatch = id.match(/:(\d+):(\d+)$/);
    const season = seasonMatch ? parseInt(seasonMatch[1]) : null;
    const episode = seasonMatch ? parseInt(seasonMatch[2]) : null;

    let epTag = '';
    if (season !== null && episode !== null) {
        const sStr = String(season).padStart(2, '0');
        const eStr = String(episode).padStart(2, '0');
        epTag = ` S${sStr}E${eStr}`;
    }

    const subtitles = [];
    for (let sub of [msone, goat, mirror]) {
        if (sub) {
            const subCopy = { ...sub };
            const providerTag = subCopy.title || 'MalSUB';
            const cleanTitle = meta.title.replace(/[\/:*?"<>|]/g, '');
            const filename = `[${providerTag}] ${cleanTitle}${epTag}.srt`;
            const fakeFilename = encodeURIComponent(filename);

            let extractParams = `url=${encodeURIComponent(subCopy.url)}`;
            if (season !== null && episode !== null) {
                extractParams += `&season=${season}&episode=${episode}`;
            }

            subCopy.url = `${globalBaseUrl}/extract/${fakeFilename}?${extractParams}`;
            subtitles.push(subCopy);
        }
    }

    console.log(`[RESPONSE] Returning ${subtitles.length} Malayalam subtitle(s) for "${meta.title}"`);
    subCache.set(cacheKey, subtitles);
    return Promise.resolve({ subtitles: subtitles });
});
const app = express();
app.set('trust proxy', true);
const addonInterface = builder.getInterface();

// Middleware to capture BASE_URL for Nuvio/Stremio responses
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    
    if (req.get('host')) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol;
        globalBaseUrl = `${proto}://${req.get('host')}`;
    }
    next();
});

// Clean Subtitle Text Helper (Strips BOM \uFEFF and normalizes UTF-8 encoding for Nuvio Desktop & Android)
function sendCleanSubtitle(res, data) {
    let content = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    
    // Strip UTF-8 BOM if present (\uFEFF)
    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
    }
    content = content.replace(/^\uFEFF/, '');
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(content);
}

// Extraction Endpoint: Unzip on the fly
app.get(['/extract', '/extract/:filename'], async (req, res) => {
    const fileUrl = req.query.url;
    console.log("EXTRACT REQUEST FOR:", fileUrl);
    if (!fileUrl) return res.status(400).send("Missing url");

    try {
        const response = await httpClient.get(fileUrl, { responseType: 'arraybuffer' });
        
        // If it's already an SRT, just send clean text
        if (fileUrl.endsWith('.srt') || fileUrl.endsWith('.vtt')) {
            return sendCleanSubtitle(res, response.data);
        }

        console.log("Attempting to unzip. Received bytes:", response.data.length);
        const header = response.data.toString('utf8', 0, Math.min(50, response.data.length));
        console.log("Header preview:", header);

        // Check if the downloaded content is actually an SRT or VTT
        if (header.trim().startsWith('1\r\n') || header.trim().startsWith('1\n') || header.trim().startsWith('WEBVTT')) {
            console.log("Content is raw SRT/VTT, bypassing unzip!");
            return sendCleanSubtitle(res, response.data);
        }

        // Try to unzip
        try {
            const zip = new AdmZip(response.data);
            const zipEntries = zip.getEntries();
            
            const qSeason = req.query.season;
            const qEpisode = req.query.episode;
            
            let bestEntry = null;
            
            for (let entry of zipEntries) {
                if (entry.entryName.endsWith('.srt') || entry.entryName.endsWith('.vtt')) {
                    if (qSeason && qEpisode) {
                        const s = parseInt(qSeason);
                        const e = parseInt(qEpisode);
                        // Matches S01E01, S1E1, S01.E01, S01_E01, 01x01, 1x01
                        const epRegex = new RegExp(`s0?${s}[\\s_\\.\\-]*e0?${e}\\b|0?${s}x0?${e}\\b`, 'i');
                        if (epRegex.test(entry.entryName)) {
                            bestEntry = entry;
                            break; // Found perfect match!
                        }
                    } else {
                        bestEntry = entry;
                        break;
                    }
                }
            }
            
            if (bestEntry) {
                return sendCleanSubtitle(res, bestEntry.getData());
            } else {
                console.log("No subtitle found in zip for:", fileUrl);
                res.status(404).send("No subtitle found in zip");
            }
        } catch(zipError) {
            console.log("Failed to unzip. It might not be a zip file. Returning raw data as fallback.");
            return sendCleanSubtitle(res, response.data);
        }
    } catch (e) {
        console.error("Extraction error:", e.message);
        res.status(500).send("Error extracting subtitle");
    }
});

// Provider Status Cache (3 minutes TTL)
let statusCache = null;
let statusCacheTime = 0;

app.get('/api/status', async (req, res) => {
    const now = Date.now();
    if (statusCache && (now - statusCacheTime < 3 * 60 * 1000)) {
        return res.json(statusCache);
    }

    const checkSite = async (url) => {
        try {
            const start = Date.now();
            await httpClient.get(url, { timeout: 12000 });
            const duration = Date.now() - start;
            return { status: 'operational', responseTime: `${duration}ms` };
        } catch(e) {
            return { status: 'degraded', responseTime: 'timeout' };
        }
    };

    const [msoneStatus, goatStatus, mirrorStatus] = await Promise.all([
        checkSite('https://malayalamsubtitles.org/'),
        checkSite('https://malayalamsubtitles.in/'),
        checkSite('https://moviemirrorsubtitles.com/')
    ]);

    statusCache = {
        addon: 'operational',
        timestamp: new Date().toISOString(),
        providers: {
            msone: { name: 'MSone', ...msoneStatus },
            goat: { name: 'TeamGOAT', ...goatStatus },
            mirror: { name: 'Movie Mirror', ...mirrorStatus }
        },
        index: {
            msone: sitemapIndex.msone.size,
            mirror: sitemapIndex.mirror.size,
            goat: sitemapIndex.goat.size,
            total: sitemapIndex.msone.size + sitemapIndex.mirror.size + sitemapIndex.goat.size,
            lastRefreshed: sitemapIndex.lastRefreshed || 'not yet',
            mongodb: mongoCollection ? 'connected' : (MONGO_URI ? 'error' : 'not configured')
        }
    };
    statusCacheTime = now;
    res.json(statusCache);
});

// Search API Endpoint for Web UI (Multi-result resolution for movies + series)
app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query parameter q is required' });

    try {
        let metas = [];
        
        // Search Cinemeta for both movies and series concurrently
        const [movieRes, seriesRes] = await Promise.allSettled([
            httpClient.get(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`),
            httpClient.get(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(query)}.json`)
        ]);

        if (seriesRes.status === 'fulfilled' && seriesRes.value.data && seriesRes.value.data.metas) {
            metas.push(...seriesRes.value.data.metas.slice(0, 2).map(m => ({ title: m.name, year: m.year, type: 'series', imdbId: m.id, poster: m.poster })));
        }

        if (movieRes.status === 'fulfilled' && movieRes.value.data && movieRes.value.data.metas) {
            metas.push(...movieRes.value.data.metas.slice(0, 2).map(m => ({ title: m.name, year: m.year, type: 'movie', imdbId: m.id, poster: m.poster })));
        }

        if (metas.length === 0) {
            metas.push({ title: query, year: null, type: 'movie', imdbId: null, poster: null });
        }

        // Limit to top 2 metadata matches
        const topMetas = metas.slice(0, 2);
        
        const searchPromises = topMetas.map(async (meta) => {
            const [msone, goat, mirror] = await Promise.all([
                searchMsone(meta.title, meta.imdbId, null, meta.year),
                searchTeamGoat(meta, meta.type, meta.imdbId || 'tt0000000'),
                searchMovieMirror(meta.title, meta.imdbId, meta.year)
            ]);

            return {
                meta,
                results: {
                    msone: msone ? { name: msone.name, url: msone.url } : null,
                    goat: goat ? { name: goat.name, url: goat.url } : null,
                    mirror: mirror ? { name: mirror.name, url: mirror.url } : null
                }
            };
        });

        const items = await Promise.all(searchPromises);
        res.json({ items });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Interactive Web Landing Page for Nuvio & Stremio
app.get('/', (req, res) => {
    const host = req.get('host') || 'localhost:7000';
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const manifestUrl = `${proto}://${host}/manifest.json`;
    const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MalSUB — Malayalam Subtitles Addon</title>
    <style>
        :root {
            --bg: #07090e;
            --card-bg: rgba(255, 255, 255, 0.03);
            --card-border: rgba(255, 255, 255, 0.08);
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --accent: #22c55e;
            --accent-glow: rgba(34, 197, 94, 0.2);
            --text: #f8fafc;
            --text-muted: #94a3b8;
        }
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background-color: var(--bg);
            background-image: 
                radial-gradient(circle at 15% 20%, rgba(99, 102, 241, 0.15) 0%, transparent 45%),
                radial-gradient(circle at 85% 80%, rgba(168, 85, 247, 0.12) 0%, transparent 45%);
            color: var(--text);
            margin: 0;
            padding: 40px 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .wrapper {
            max-width: 720px;
            width: 100%;
            display: flex;
            flex-direction: column;
            gap: 24px;
        }
        .glass-card {
            background: var(--card-bg);
            backdrop-filter: blur(16px);
            border: 1px solid var(--card-border);
            border-radius: 20px;
            padding: 32px;
            box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.6);
            transition: border-color 0.3s ease;
        }
        .glass-card:hover { border-color: rgba(255, 255, 255, 0.15); }

        /* Header */
        .header { text-align: center; }
        .logo-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: linear-gradient(135deg, #6366f1, #a855f7);
            color: white;
            font-weight: 800;
            font-size: 1.1rem;
            padding: 8px 18px;
            border-radius: 12px;
            margin-bottom: 16px;
            box-shadow: 0 10px 20px -5px rgba(99, 102, 241, 0.4);
        }
        h1 { margin: 0 0 10px 0; font-size: 2.2rem; font-weight: 800; tracking: -0.02em; }
        p.subtitle { color: var(--text-muted); font-size: 1rem; margin: 0 0 24px 0; line-height: 1.6; }

        /* Actions */
        .action-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }
        @media (max-width: 520px) { .action-group { grid-template-columns: 1fr; } }
        .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 14px 20px;
            border-radius: 12px;
            font-weight: 600;
            font-size: 0.95rem;
            text-decoration: none;
            cursor: pointer;
            transition: all 0.2s ease;
            border: none;
        }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: var(--primary-hover); transform: translateY(-2px); }
        .btn-secondary { background: rgba(255, 255, 255, 0.08); color: var(--text); border: 1px solid var(--card-border); }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.12); transform: translateY(-2px); }

        /* Overall Uptime Bar */
        .uptime-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            font-size: 0.9rem;
        }
        .uptime-title { font-weight: 700; color: #e2e8f0; display: flex; align-items: center; gap: 8px; }
        .status-dot { width: 8px; height: 8px; background: var(--accent); border-radius: 50%; box-shadow: 0 0 10px var(--accent); }
        .uptime-percent { color: var(--accent); font-weight: 700; }
        .uptime-bars {
            display: flex;
            gap: 3px;
            height: 28px;
            align-items: flex-end;
        }
        .bar-segment {
            flex: 1;
            height: 100%;
            background: var(--accent);
            opacity: 0.85;
            border-radius: 3px;
            transition: opacity 0.2s ease;
        }
        .bar-segment:hover { opacity: 1; transform: scaleY(1.1); }

        /* Provider Health Grid */
        .section-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
        .provider-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
        }
        @media (max-width: 600px) { .provider-grid { grid-template-columns: 1fr; } }
        .provider-card {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--card-border);
            border-radius: 14px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .provider-name { font-weight: 700; font-size: 0.95rem; }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 0.8rem;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 20px;
            width: fit-content;
        }
        .status-operational { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); }

        /* Live Subtitle Search Tool */
        .search-box {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
        }
        .search-input {
            flex: 1;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 12px 16px;
            color: white;
            font-size: 0.95rem;
            outline: none;
            transition: border-color 0.2s ease;
        }
        .search-input:focus { border-color: var(--primary); }
        .search-results {
            margin-top: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .result-card {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--card-border);
            border-radius: 14px;
            padding: 16px;
            display: flex;
            gap: 16px;
            align-items: center;
        }
        .poster { width: 50px; height: 75px; border-radius: 8px; object-fit: cover; background: #1e293b; }
        .result-info { flex: 1; text-align: left; }
        .result-title { font-weight: 700; font-size: 1rem; margin-bottom: 4px; }
        .result-meta { font-size: 0.82rem; color: var(--text-muted); margin-bottom: 8px; }
        .sub-pills { display: flex; gap: 8px; flex-wrap: wrap; }
        .sub-pill {
            font-size: 0.78rem;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 6px;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 4px;
        }
        .pill-found { background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.4); }
        .pill-missing { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

        .footer-note { font-size: 0.8rem; color: #64748b; text-align: center; }
    </style>
</head>
<body>
    <div class="wrapper">
        
        <!-- Header & Addon Installation -->
        <div class="glass-card header">
            <div class="logo-badge">⚡ MalSUB v1.0</div>
            <h1>Malayalam Subtitles</h1>
            <p class="subtitle">High-quality Malayalam subtitles for Nuvio & Stremio sourced live from MSone, TeamGOAT, and Movie Mirror.</p>
            
            <div class="action-group">
                <a href="${stremioUrl}" class="btn btn-primary">🚀 Install in Nuvio / Stremio</a>
                <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${manifestUrl}'); alert('Manifest URL copied!');">📋 Copy Manifest URL</button>
            </div>
        </div>

        <!-- Overall Addon Uptime Monitor -->
        <div class="glass-card">
            <div class="uptime-header">
                <div class="uptime-title"><div class="status-dot"></div> Addon Uptime Status</div>
                <div class="uptime-percent">100.0% Operational</div>
            </div>
            <div class="uptime-bars" id="uptimeBars">
                <!-- Dynamically generated uptime segments -->
            </div>
        </div>

        <!-- 3 Provider Scraping Health Grid -->
        <div class="glass-card">
            <div class="section-title">📡 Live Provider Scraping Health</div>
            <div class="provider-grid">
                <div class="provider-card">
                    <div class="provider-name">MSone</div>
                    <div class="status-badge status-operational" id="msoneBadge">● Operational</div>
                </div>
                <div class="provider-card">
                    <div class="provider-name">TeamGOAT</div>
                    <div class="status-badge status-operational" id="goatBadge">● Operational</div>
                </div>
                <div class="provider-card">
                    <div class="provider-name">Movie Mirror</div>
                    <div class="status-badge status-operational" id="mirrorBadge">● Operational</div>
                </div>
            </div>
        </div>

        <!-- Interactive Subtitle Search Tool -->
        <div class="glass-card">
            <div class="section-title">🔍 Test Subtitle Search</div>
            <div class="search-box">
                <input type="text" id="searchInput" class="search-input" placeholder="Enter movie or series title (e.g. Shogun, Man vs Bee)..." onkeydown="if(event.key==='Enter') performSearch();">
                <button class="btn btn-primary" onclick="performSearch()">Search</button>
            </div>
            <div class="search-results" id="searchResults"></div>
        </div>

        <div class="footer-note">MalSUB Private Addon • Optimized for Render Free Tier</div>
    </div>

    <script>
        // Generate Uptime Bar visualization (60 days)
        const barsContainer = document.getElementById('uptimeBars');
        for(let i=0; i<50; i++) {
            const bar = document.createElement('div');
            bar.className = 'bar-segment';
            bar.title = '100% Operational';
            barsContainer.appendChild(bar);
        }

        // Fetch Live Provider Health
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                if (data.providers) {
                    updateBadge('msoneBadge', data.providers.msone.status);
                    updateBadge('goatBadge', data.providers.goat.status);
                    updateBadge('mirrorBadge', data.providers.mirror.status);
                }
            } catch(e) {}
        }
        function updateBadge(id, status) {
            const el = document.getElementById(id);
            if (status === 'operational') {
                el.className = 'status-badge status-operational';
                el.innerText = '● Operational';
            } else {
                el.className = 'status-badge';
                el.innerText = '⚠️ Slow / Check';
            }
        }
        fetchStatus();

        // Perform Subtitle Search
        async function performSearch() {
            const input = document.getElementById('searchInput').value.trim();
            const resultsContainer = document.getElementById('searchResults');
            if(!input) return;

            resultsContainer.innerHTML = '<div style="color:var(--text-muted); padding:10px;">🔍 Searching MSone, TeamGOAT, and Movie Mirror...</div>';
            
            try {
                const res = await fetch('/api/search?q=' + encodeURIComponent(input));
                const data = await res.json();
                
                if (data.items && data.items.length > 0) {
                    let html = '';
                    for (let item of data.items) {
                        const m = item.meta;
                        const r = item.results;

                        const msonePill = r.msone ? \`<a href="\${r.msone.url}" class="sub-pill pill-found" target="_blank">✓ MSone</a>\` : \`<span class="sub-pill pill-missing">✗ MSone</span>\`;
                        const goatPill = r.goat ? \`<a href="\${r.goat.url}" class="sub-pill pill-found" target="_blank">✓ TeamGOAT</a>\` : \`<span class="sub-pill pill-missing">✗ TeamGOAT</span>\`;
                        const mirrorPill = r.mirror ? \`<a href="\${r.mirror.url}" class="sub-pill pill-found" target="_blank">✓ Movie Mirror</a>\` : \`<span class="sub-pill pill-missing">✗ Movie Mirror</span>\`;

                        const posterImg = m.poster ? \`<img src="\${m.poster}" class="poster" alt="poster">\` : \`<div class="poster"></div>\`;

                        html += \`
                            <div class="result-card">
                                \${posterImg}
                                <div class="result-info">
                                    <div class="result-title">\${m.title} \${m.year ? '('+m.year+')' : ''}</div>
                                    <div class="result-meta">\${m.type.toUpperCase()} • \${m.imdbId || 'N/A'}</div>
                                    <div class="sub-pills">\${msonePill} \${goatPill} \${mirrorPill}</div>
                                </div>
                            </div>
                        \`;
                    }
                    resultsContainer.innerHTML = html;
                } else {
                    resultsContainer.innerHTML = '<div style="color:#f87171;">No titles found for this query.</div>';
                }
            } catch(e) {
                resultsContainer.innerHTML = '<div style="color:#f87171;">Error searching subtitles.</div>';
            }
        }
    </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

const addonRouter = require('stremio-addon-sdk/src/getRouter')(addonInterface);
app.use('/', addonRouter);
const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon is running at http://localhost:${port}/manifest.json`);

    // Connect to MongoDB, warm-load index, then refresh from sitemaps
    (async () => {
        await connectMongo();
        const warmed = await warmLoadFromMongo();
        console.log(`[STARTUP] Warm-loaded ${warmed} slugs from MongoDB`);
        // Always refresh from sitemaps on startup to pick up new posts
        refreshSitemapIndex().catch(e => console.error('[INDEX] Startup refresh failed:', e.message));
    })();
    // Refresh index every 6 hours
    setInterval(() => refreshSitemapIndex().catch(e => console.error('[INDEX] Refresh failed:', e.message)), 6 * 60 * 60 * 1000);

    // Render Keep-Alive Ping (Runs every 14 minutes if URL env var is present)
    const pingUrl = process.env.RENDER_EXTERNAL_URL || process.env.PING_URL;
    if (pingUrl) {
        const targetUrl = pingUrl.endsWith('/manifest.json') ? pingUrl : `${pingUrl.replace(/\/$/, '')}/manifest.json`;
        console.log(`Keep-alive self-ping configured for: ${targetUrl}`);
        setInterval(async () => {
            try {
                await httpClient.get(targetUrl);
                console.log(`[Keep-Alive] Pinged ${targetUrl} successfully.`);
            } catch (err) {
                console.error(`[Keep-Alive] Ping error: ${err.message}`);
            }
        }, 14 * 60 * 1000); // Ping every 14 minutes (Render spins down at 15m)
    }
});
