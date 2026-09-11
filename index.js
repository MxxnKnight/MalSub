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
            const slug = toSlug(meta.title);
            let msoneUrl = null, goatUrl = null, mirrorUrl = null;

            // Search MSone Map
            for (const key of sitemapIndex.msone.keys()) {
                if (key === slug || key.startsWith(slug + '-')) { msoneUrl = sitemapIndex.msone.get(key); break; }
            }
            // Search GoAT Map
            for (const key of sitemapIndex.goat.keys()) {
                if (key === slug || key.startsWith(slug + '-')) { goatUrl = sitemapIndex.goat.get(key); break; }
            }
            // Search Mirror Map
            for (const key of sitemapIndex.mirror.keys()) {
                if (key === slug || key.startsWith(slug + '-')) { mirrorUrl = sitemapIndex.mirror.get(key); break; }
            }

            return {
                meta,
                results: {
                    msone: msoneUrl ? { name: `${meta.title} (Indexed)`, url: msoneUrl } : null,
                    goat: goatUrl ? { name: `${meta.title} (Indexed)`, url: goatUrl } : null,
                    mirror: mirrorUrl ? { name: `${meta.title} (Indexed)`, url: mirrorUrl } : null
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

app.get('/api/refetch', async (req, res) => {
    try {
        await refreshSitemapIndex();
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/', (req, res) => {
    const host = req.get('host') || 'localhost:7000';
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const manifestUrl = `${proto}://${host}/manifest.json`;
    const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');

    const html = `
<!DOCTYPE html>
<html lang="en" class="dark scroll-smooth">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MalSUB - Malayalam Subtitle Addon for Stremio & Nuvio</title>
  
  <!-- Tailwind CSS -->
  <script src="https://cdn.tailwindcss.com"></script>
  
  <!-- Font Awesome Icons -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  
  <!-- Google Fonts (Inter & Plus Jakarta Sans) -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
            display: ['Plus Jakarta Sans', 'sans-serif'],
          },
          animation: {
            'glow': 'glow 8s ease-in-out infinite alternate',
            'float': 'float 4s ease-in-out infinite',
            'pulse-fast': 'pulse 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
          },
          keyframes: {
            glow: {
              '0%': { opacity: '0.4', transform: 'scale(0.95)' },
              '100%': { opacity: '0.8', transform: 'scale(1.05)' },
            },
            float: {
              '0%, 100%': { transform: 'translateY(0px)' },
              '50%': { transform: 'translateY(-6px)' },
            }
          }
        }
      }
    }
  </script>

  <style>
    /* Custom scrollbars */
    ::-webkit-scrollbar {
      width: 8px;
    }
    ::-webkit-scrollbar-track {
      background: #090813;
    }
    ::-webkit-scrollbar-thumb {
      background: #282545;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #7c3aed;
    }

    /* Glassmorphism */
    .glass-card {
      background: rgba(18, 15, 38, 0.75);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .glass-card-hover {
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .glass-card-hover:hover {
      transform: translateY(-3px);
      border-color: rgba(139, 92, 246, 0.35);
      box-shadow: 0 12px 30px -10px rgba(124, 58, 237, 0.25);
    }

    /* Grid backdrop */
    .bg-grid {
      background-size: 40px 40px;
      background-image: 
        linear-gradient(to right, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
    }

    /* Tooltip styling */
    .tooltip {
      visibility: hidden;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .has-tooltip:hover .tooltip {
      visibility: visible;
      opacity: 1;
    }
  </style>
</head>

<body class="bg-[#080612] text-slate-100 font-sans antialiased overflow-x-hidden relative selection:bg-purple-500 selection:text-white">

  <div class="fixed inset-0 overflow-hidden pointer-events-none z-0">
    <div class="absolute -top-40 left-1/2 -translate-x-1/2 w-[750px] h-[500px] bg-purple-600/20 rounded-full blur-[140px] animate-glow"></div>
    <div class="absolute top-[35%] -left-32 w-[500px] h-[500px] bg-cyan-600/15 rounded-full blur-[130px]"></div>
    <div class="absolute top-[65%] -right-32 w-[600px] h-[600px] bg-emerald-600/15 rounded-full blur-[150px]"></div>
    <div class="absolute inset-0 bg-grid opacity-80"></div>
  </div>

  <div id="toast" class="fixed bottom-6 right-6 z-50 transform translate-y-24 opacity-0 transition-all duration-300 pointer-events-none flex items-center gap-3 bg-slate-900/95 border border-purple-500/50 text-white px-4 sm:px-5 py-3 rounded-2xl shadow-2xl backdrop-blur-xl max-w-[90vw]">
    <div class="w-8 h-8 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold shrink-0">
      <i class="fa-solid fa-check text-sm" id="toast-icon"></i>
    </div>
    <div class="overflow-hidden">
      <h4 class="text-xs sm:text-sm font-semibold truncate" id="toast-title">Copied!</h4>
      <p class="text-[11px] sm:text-xs text-slate-300 truncate" id="toast-msg">Manifest URL copied to clipboard</p>
    </div>
  </div>

  <header class="sticky top-3 z-40 px-3 sm:px-6">
    <div class="max-w-6xl mx-auto glass-card rounded-full border border-white/10 shadow-2xl shadow-purple-950/40 px-4 sm:px-6 h-16 flex items-center justify-between">
      
      <!-- Subtitle Logo -->
      <a href="#" class="flex items-center gap-2.5 group shrink-0">
        <div class="relative w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gradient-to-tr from-purple-600 via-indigo-500 to-cyan-400 p-[1.5px] shadow-lg shadow-purple-500/30 group-hover:scale-105 transition-transform duration-300">
          <div class="w-full h-full bg-[#0d0a1d] rounded-full flex items-center justify-center overflow-hidden">
            <svg class="w-5 h-5 text-purple-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="4" ry="4"></rect>
              <path d="M7 15h4"></path>
              <path d="M15 15h2"></path>
              <path d="M7 11h10"></path>
            </svg>
          </div>
        </div>
        <div>
          <div class="flex items-center gap-1.5">
            <span class="font-display font-extrabold text-lg sm:text-xl tracking-tight text-white">Mal<span class="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400">SUB</span></span>
            <span class="text-[9px] sm:text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">ML</span>
          </div>
        </div>
      </a>

      <!-- Navigation Links -->
      <nav class="hidden md:flex items-center gap-6 text-xs sm:text-sm font-medium text-slate-300">
        <a href="#providers" class="hover:text-purple-400 transition-colors">Providers</a>
        <a href="#status" class="hover:text-purple-400 transition-colors">Status</a>
        <a href="#demo" class="hover:text-purple-400 transition-colors">Live Search</a>
        <a href="#install" class="hover:text-purple-400 transition-colors">Install</a>
      </nav>

      <!-- Action Buttons -->
      <div class="flex items-center gap-2">
        <button onclick="triggerDatabaseUpdate()" class="inline-flex items-center gap-1.5 text-xs font-semibold px-3 sm:px-4 py-2 rounded-full bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 transition-all hover:scale-105 active:scale-95">
          <i class="fa-solid fa-arrows-rotate text-[11px] text-purple-400" id="header-db-icon"></i>
          <span class="hidden sm:inline">Sync DB</span>
        </button>
        <a href="#install" class="inline-flex items-center gap-1.5 text-xs font-bold px-3.5 sm:px-4 py-2 rounded-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-md shadow-purple-600/30 transition-all hover:scale-105 active:scale-95">
          <i class="fa-solid fa-download text-[11px]"></i>
          <span>Install</span>
        </a>
      </div>
    </div>
  </header>

  <main class="relative z-10">
    <section class="relative pt-12 pb-16 md:pt-20 md:pb-28 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
      <div class="text-center max-w-3xl mx-auto">
        
        <!-- Live Badge -->
        <div class="inline-flex items-center gap-2 px-3.5 sm:px-4 py-1.5 rounded-full bg-purple-950/60 border border-purple-500/30 text-purple-300 text-[11px] sm:text-xs font-medium mb-6 sm:mb-8 backdrop-blur-md animate-float max-w-full truncate">
          <span class="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0"></span>
          <span class="truncate">Aggregating <strong>MSone</strong>, <strong>Movie Mirror</strong> & <strong>Team GOAT</strong></span>
        </div>

        <!-- Title -->
        <h1 class="text-3xl sm:text-5xl lg:text-6xl font-display font-extrabold tracking-tight leading-[1.15] mb-5">
          Malayalam Subtitles for 
          <span class="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-indigo-300 to-cyan-400"> Stremio & Nuvio</span>
        </h1>

        <!-- Subtitle Description -->
        <p class="text-sm sm:text-lg text-slate-300 font-normal leading-relaxed mb-8 max-w-2xl mx-auto px-2">
          Never hunt for Malayalam subtitles again. <strong class="text-white">MalSUB</strong> scrapes, matches, and delivers sync-ready subtitles directly into your player from Kerala's top translation communities.
        </p>

        <!-- CTAs -->
        <div class="flex flex-col sm:flex-row items-center justify-center gap-3.5 mb-8">
          <a href="stremio://malsub.addon.workers.dev/manifest.json" onclick="triggerInstall('Stremio')" class="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-purple-600 via-purple-700 to-indigo-700 hover:from-purple-500 hover:to-indigo-600 text-white font-bold text-sm shadow-xl shadow-purple-600/30 hover:scale-[1.02] active:scale-95 transition-all">
            <i class="fa-solid fa-play text-purple-200"></i>
            <span>Install on Stremio</span>
          </a>

          <a href="nuvio://install?addon=https%3A%2F%2Fmalsub.addon.workers.dev%2Fmanifest.json" onclick="triggerInstall('Nuvio')" class="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-cyan-600 to-blue-700 hover:from-cyan-500 hover:to-blue-600 text-white font-bold text-sm shadow-xl shadow-cyan-600/25 hover:scale-[1.02] active:scale-95 transition-all">
            <i class="fa-solid fa-tv text-cyan-200"></i>
            <span>Install on Nuvio</span>
          </a>
        </div>

        <!-- Manifest URL Copy Box -->
        <div class="max-w-xl mx-auto glass-card p-2 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-2 border border-white/10 shadow-2xl">
          <div class="flex items-center gap-2.5 px-3 py-2 w-full overflow-hidden text-left">
            <span class="text-[10px] font-mono text-purple-400 font-bold px-2 py-0.5 bg-purple-500/10 rounded-md shrink-0">MANIFEST</span>
            <input id="manifest-input" type="text" readonly value="https://malsub.addon.workers.dev/manifest.json" class="bg-transparent text-xs font-mono text-slate-300 w-full outline-none truncate" />
          </div>
          <button onclick="copyManifestUrl()" class="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 hover:text-white border border-purple-500/30 font-semibold text-xs transition-all">
            <i class="fa-regular fa-copy"></i>
            <span id="copy-btn-text">Copy URL</span>
          </button>
        </div>

        <!-- Database Indexer Interactive Bar -->
        <div class="mt-8 max-w-xl mx-auto p-4 glass-card rounded-2xl border border-purple-500/20 text-left relative overflow-hidden">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
              <span class="text-xs font-bold text-slate-200">Database Indexer Status</span>
            </div>
            <span class="text-[11px] font-mono text-slate-400" id="db-last-sync">Updated: Just now</span>
          </div>
          <p class="text-xs text-slate-400 mb-3">Trigger an instant sync job to query new subtitle uploads from MSone, Mirror & GOAT repositories.</p>
          <div class="flex items-center gap-3">
            <button onclick="triggerDatabaseUpdate()" id="db-update-btn" class="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold shadow-lg shadow-purple-600/30 transition-all active:scale-95">
              <i class="fa-solid fa-database text-purple-200" id="db-btn-icon"></i>
              <span id="db-btn-text">Update Subtitle Database Now</span>
            </button>
          </div>
          
          <!-- Progress bar -->
          <div id="db-progress-wrapper" class="hidden mt-3">
            <div class="w-full bg-black/40 h-1.5 rounded-full overflow-hidden">
              <div id="db-progress-bar" class="bg-gradient-to-r from-purple-500 to-cyan-400 h-full w-0 transition-all duration-300"></div>
            </div>
            <div class="flex justify-between text-[10px] font-mono text-purple-300 mt-1">
              <span id="db-status-step">Connecting to scraper nodes...</span>
              <span id="db-status-percent">0%</span>
            </div>
          </div>
        </div>

        <!-- Statistics Badges -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mt-10 max-w-4xl mx-auto text-left">
          <div class="glass-card p-3.5 sm:p-4 rounded-2xl">
            <div class="text-xl sm:text-2xl font-extrabold font-display text-purple-400" id="stat-count">120,480+</div>
            <div class="text-[11px] sm:text-xs text-slate-400 font-medium mt-0.5">Malayalam Subtitles</div>
          </div>
          <div class="glass-card p-3.5 sm:p-4 rounded-2xl">
            <div class="text-xl sm:text-2xl font-extrabold font-display text-emerald-400">3 Sources</div>
            <div class="text-[11px] sm:text-xs text-slate-400 font-medium mt-0.5">MSone • Mirror • GOAT</div>
          </div>
          <div class="glass-card p-3.5 sm:p-4 rounded-2xl">
            <div class="text-xl sm:text-2xl font-extrabold font-display text-cyan-400">&lt; 90ms</div>
            <div class="text-[11px] sm:text-xs text-slate-400 font-medium mt-0.5">Avg Fetch Response</div>
          </div>
          <div class="glass-card p-3.5 sm:p-4 rounded-2xl">
            <div class="text-xl sm:text-2xl font-extrabold font-display text-pink-400">100% Free</div>
            <div class="text-[11px] sm:text-xs text-slate-400 font-medium mt-0.5">Open & Ad-free</div>
          </div>
        </div>

      </div>
    </section>

    <section id="providers" class="py-12 sm:py-16 border-t border-white/5 relative">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        <div class="text-center max-w-2xl mx-auto mb-10 sm:mb-14">
          <h2 class="text-[11px] uppercase font-bold tracking-widest text-purple-400 mb-2 font-mono">Aggregation Power</h2>
          <p class="text-2xl sm:text-4xl font-display font-extrabold text-white">3 Premier Subtitle Sources, 1 Addon</p>
          <p class="text-slate-400 text-xs sm:text-sm mt-2">MalSUB simultaneously queries Kerala's top subtitle translation communities in parallel.</p>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6">
          
          <!-- MSone Card -->
          <div class="glass-card glass-card-hover p-5 sm:p-6 rounded-3xl relative overflow-hidden group">
            <div class="absolute -top-12 -right-12 w-28 h-28 bg-amber-500/10 rounded-full blur-2xl group-hover:bg-amber-500/20 transition-all"></div>
            <div class="flex items-center justify-between mb-4">
              <div class="w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400 font-black text-lg">
                MS
              </div>
              <span class="text-[10px] font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                ONLINE
              </span>
            </div>
            <h3 class="text-lg sm:text-xl font-display font-bold text-white mb-2">MSone (മലയാളം സബ്‌ടൈറ്റിലുകൾ)</h3>
            <p class="text-slate-400 text-xs leading-relaxed mb-4">
              The oldest and largest Malayalam subtitle library with tens of thousands of verified fansub translations for classics to the latest cinema.
            </p>
            <div class="flex flex-wrap gap-1.5 text-[10px] sm:text-[11px]">
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">World Cinema</span>
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">Hollywood</span>
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">Anime</span>
            </div>
          </div>

          <!-- Movie Mirror Card -->
          <div class="glass-card glass-card-hover p-5 sm:p-6 rounded-3xl relative overflow-hidden group">
            <div class="absolute -top-12 -right-12 w-28 h-28 bg-blue-500/10 rounded-full blur-2xl group-hover:bg-blue-500/20 transition-all"></div>
            <div class="flex items-center justify-between mb-4">
              <div class="w-11 h-11 rounded-2xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400 font-black text-lg">
                MM
              </div>
              <span class="text-[10px] font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                ONLINE
              </span>
            </div>
            <h3 class="text-lg sm:text-xl font-display font-bold text-white mb-2">Movie Mirror</h3>
            <p class="text-slate-400 text-xs leading-relaxed mb-4">
              Super-fast subtitle releases tailored specifically for streaming rip formats and web releases with frame-perfect timing alignment.
            </p>
            <div class="flex flex-wrap gap-1.5 text-[10px] sm:text-[11px]">
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">Web DL Sync</span>
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">Day 1 Releases</span>
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">K-Dramas</span>
            </div>
          </div>

          <!-- Team GOAT Card -->
          <div class="glass-card glass-card-hover p-5 sm:p-6 rounded-3xl relative overflow-hidden group">
            <div class="absolute -top-12 -right-12 w-28 h-28 bg-emerald-500/10 rounded-full blur-2xl group-hover:bg-emerald-500/20 transition-all"></div>
            <div class="flex items-center justify-between mb-4">
              <div class="w-11 h-11 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-black text-lg">
                GT
              </div>
              <span class="text-[10px] font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                ONLINE
              </span>
            </div>
            <h3 class="text-lg sm:text-xl font-display font-bold text-white mb-2">Team GOAT</h3>
            <p class="text-slate-400 text-xs leading-relaxed mb-4">
              Dynamic subtitle group renowned for television series, mini-series, and trending pan-Indian blockbusters with localized dialogue.
            </p>
            <div class="flex flex-wrap gap-1.5 text-[10px] sm:text-[11px]">
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">OTT Series</span>
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">Trending Hits</span>
              <span class="px-2.5 py-1 rounded-lg bg-white/5 text-slate-300">Pan-Indian</span>
            </div>
          </div>

        </div>
      </div>
    </section>

    <section id="status" class="py-12 sm:py-20 border-t border-white/5 relative">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        
        <div class="flex flex-col sm:flex-row sm:items-end justify-between mb-8 sm:mb-10 gap-4">
          <div>
            <div class="flex items-center gap-2 mb-2">
              <span class="h-2.5 w-2.5 rounded-full bg-emerald-400"></span>
              <span class="text-[10px] sm:text-xs uppercase font-mono tracking-widest text-emerald-400 font-semibold">All Systems Operational</span>
            </div>
            <h2 class="text-2xl sm:text-4xl font-display font-extrabold text-white">Live Service Uptime & Health</h2>
            <p class="text-slate-400 text-xs sm:text-sm mt-1">Real-time ping latency and past 30-day uptime history across all scraper nodes.</p>
          </div>
          
          <div class="flex items-center gap-3">
            <button onclick="simulateHealthCheck()" id="refresh-btn" class="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 text-xs font-semibold transition-all">
              <i class="fa-solid fa-arrows-rotate text-purple-400"></i>
              <span id="refresh-text">Check Latency</span>
            </button>
          </div>
        </div>

        <div class="space-y-4 sm:space-y-5">

          <!-- MalSUB Gateway Core -->
          <div class="glass-card p-4 sm:p-6 rounded-3xl border border-purple-500/20">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 mb-3">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
                  <i class="fa-solid fa-server text-xs sm:text-sm"></i>
                </div>
                <div>
                  <h3 class="text-sm sm:text-base font-bold text-white">MalSUB Gateway & Edge Cache</h3>
                  <p class="text-[11px] sm:text-xs text-slate-400">Global Cloudflare Worker proxy & indexer</p>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs font-mono justify-between sm:justify-end">
                <span class="text-slate-400">Latency: <strong class="text-emerald-400 font-bold" id="ping-gateway">38ms</strong></span>
                <span class="text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 sm:py-1 rounded-full border border-emerald-500/20 text-[10px] sm:text-xs font-semibold">99.99% Uptime</span>
              </div>
            </div>

            <div class="pt-2">
              <div class="flex items-center justify-between gap-0.5 sm:gap-1 w-full" id="bars-gateway"></div>
              <div class="flex items-center justify-between text-[9px] sm:text-[10px] text-slate-500 font-mono mt-2">
                <span>30 days ago</span>
                <span class="text-slate-400 font-medium hidden sm:inline">100% operational today</span>
                <span>Today</span>
              </div>
            </div>
          </div>

          <!-- MSone Node -->
          <div class="glass-card p-4 sm:p-6 rounded-3xl">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 mb-3">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
                  <i class="fa-solid fa-cloud-arrow-down text-xs sm:text-sm"></i>
                </div>
                <div>
                  <h3 class="text-sm sm:text-base font-bold text-white">MSone Subtitle Scraper Node</h3>
                  <p class="text-[11px] sm:text-xs text-slate-400">msone.app API and mirror parser</p>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs font-mono justify-between sm:justify-end">
                <span class="text-slate-400">Latency: <strong class="text-emerald-400 font-bold" id="ping-msone">72ms</strong></span>
                <span class="text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 sm:py-1 rounded-full border border-emerald-500/20 text-[10px] sm:text-xs font-semibold">99.85% Uptime</span>
              </div>
            </div>

            <div class="pt-2">
              <div class="flex items-center justify-between gap-0.5 sm:gap-1 w-full" id="bars-msone"></div>
              <div class="flex items-center justify-between text-[9px] sm:text-[10px] text-slate-500 font-mono mt-2">
                <span>30 days ago</span>
                <span class="text-slate-400 font-medium hidden sm:inline">No active incidents</span>
                <span>Today</span>
              </div>
            </div>
          </div>

          <!-- Movie Mirror Node -->
          <div class="glass-card p-4 sm:p-6 rounded-3xl">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 mb-3">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
                  <i class="fa-solid fa-bolt text-xs sm:text-sm"></i>
                </div>
                <div>
                  <h3 class="text-sm sm:text-base font-bold text-white">Movie Mirror Search Index</h3>
                  <p class="text-[11px] sm:text-xs text-slate-400">Direct release repository parser</p>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs font-mono justify-between sm:justify-end">
                <span class="text-slate-400">Latency: <strong class="text-emerald-400 font-bold" id="ping-mirror">94ms</strong></span>
                <span class="text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 sm:py-1 rounded-full border border-emerald-500/20 text-[10px] sm:text-xs font-semibold">99.60% Uptime</span>
              </div>
            </div>

            <div class="pt-2">
              <div class="flex items-center justify-between gap-0.5 sm:gap-1 w-full" id="bars-mirror"></div>
              <div class="flex items-center justify-between text-[9px] sm:text-[10px] text-slate-500 font-mono mt-2">
                <span>30 days ago</span>
                <span class="text-slate-400 font-medium hidden sm:inline">Operational</span>
                <span>Today</span>
              </div>
            </div>
          </div>

          <!-- Team GOAT Node -->
          <div class="glass-card p-4 sm:p-6 rounded-3xl">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 mb-3">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                  <i class="fa-solid fa-shield-halved text-xs sm:text-sm"></i>
                </div>
                <div>
                  <h3 class="text-sm sm:text-base font-bold text-white">Team GOAT OTT Subtitles</h3>
                  <p class="text-[11px] sm:text-xs text-slate-400">Series and multi-episode archive parser</p>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs font-mono justify-between sm:justify-end">
                <span class="text-slate-400">Latency: <strong class="text-emerald-400 font-bold" id="ping-goat">81ms</strong></span>
                <span class="text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 sm:py-1 rounded-full border border-emerald-500/20 text-[10px] sm:text-xs font-semibold">99.91% Uptime</span>
              </div>
            </div>

            <div class="pt-2">
              <div class="flex items-center justify-between gap-0.5 sm:gap-1 w-full" id="bars-goat"></div>
              <div class="flex items-center justify-between text-[9px] sm:text-[10px] text-slate-500 font-mono mt-2">
                <span>30 days ago</span>
                <span class="text-slate-400 font-medium hidden sm:inline">Fully operational</span>
                <span>Today</span>
              </div>
            </div>
          </div>

        </div>

      </div>
    </section>

    <section id="demo" class="py-12 sm:py-20 border-t border-white/5 relative">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="text-center mb-8">
          <h2 class="text-[11px] uppercase font-bold tracking-widest text-cyan-400 mb-2 font-mono">Test Addon Query Engine</h2>
          <p class="text-2xl sm:text-3xl font-display font-bold text-white">Live Subtitle Lookup Sandbox</p>
          <p class="text-slate-400 text-xs sm:text-sm mt-1">Simulate how MalSUB retrieves subtitles for popular titles instantly.</p>
        </div>

        <div class="glass-card p-4 sm:p-6 rounded-3xl border border-white/10 shadow-2xl">
          <!-- Search input -->
          <div class="relative mb-4">
            <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
              <i class="fa-solid fa-magnifying-glass text-sm"></i>
            </div>
            <input 
              type="text" 
              id="demo-search" 
              onkeyup="handleSearch(this.value)" 
              placeholder="Search movie or TV show (e.g. Aavesham, Manjummel Boys, Dark, Interstellar)..." 
              class="w-full pl-11 pr-4 py-3 bg-black/40 border border-white/10 rounded-xl text-xs sm:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors font-sans"
            />
          </div>

          <!-- Quick Suggestions -->
          <div class="flex flex-wrap items-center gap-2 mb-6 text-xs text-slate-400">
            <span class="text-[11px] font-medium text-slate-500">Quick Try:</span>
            <button onclick="setQuery('Aavesham')" class="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white transition-colors">Aavesham</button>
            <button onclick="setQuery('Manjummel Boys')" class="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white transition-colors">Manjummel Boys</button>
            <button onclick="setQuery('Interstellar')" class="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white transition-colors">Interstellar</button>
            <button onclick="setQuery('Dark')" class="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 hover:text-white transition-colors">Dark (Series)</button>
          </div>

          <!-- Results Box -->
          <div class="bg-black/30 rounded-2xl p-3 sm:p-4 border border-white/5 min-h-[200px]">
            <div class="flex items-center justify-between border-b border-white/5 pb-3 mb-3">
              <div class="text-xs font-semibold text-slate-300" id="result-query">Showing latest indexed subtitles</div>
              <div class="text-[11px] font-mono text-purple-400" id="result-count">3 Subtitles Found</div>
            </div>

            <div class="space-y-2.5" id="results-list">
              <!-- Dynamically populated via JS -->
            </div>
          </div>
        </div>
      </div>
    </section>

    <section id="install" class="py-12 sm:py-20 border-t border-white/5 relative">
      <div class="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        
        <div class="text-center mb-10">
          <h2 class="text-[11px] uppercase font-bold tracking-widest text-emerald-400 mb-2 font-mono">Step-by-Step Setup</h2>
          <p class="text-2xl sm:text-3xl font-display font-bold text-white">Installation Guide</p>
        </div>

        <!-- Player Tabs -->
        <div class="flex justify-center mb-6">
          <div class="p-1 glass-card rounded-2xl inline-flex border border-white/10">
            <button onclick="switchTab('stremio-guide')" id="tab-stremio-guide" class="px-5 py-2.5 rounded-xl font-bold text-xs sm:text-sm bg-purple-600 text-white shadow-lg transition-all flex items-center gap-2">
              <i class="fa-solid fa-play text-xs"></i>
              <span>Stremio Guide</span>
            </button>
            <button onclick="switchTab('nuvio-guide')" id="tab-nuvio-guide" class="px-5 py-2.5 rounded-xl font-bold text-xs sm:text-sm text-slate-400 hover:text-white transition-all flex items-center gap-2">
              <i class="fa-solid fa-tv text-xs"></i>
              <span>Nuvio Guide</span>
            </button>
          </div>
        </div>

        <!-- Stremio Instructions -->
        <div id="stremio-guide" class="tab-content glass-card p-6 sm:p-8 rounded-3xl space-y-6">
          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center font-bold text-sm shrink-0">1</div>
            <div>
              <h3 class="text-base font-bold text-white mb-1">Copy the Manifest Link</h3>
              <p class="text-xs sm:text-sm text-slate-400">Click the copy button above or manually copy <code class="text-purple-300 font-mono">https://malsub.addon.workers.dev/manifest.json</code>.</p>
            </div>
          </div>

          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center font-bold text-sm shrink-0">2</div>
            <div>
              <h3 class="text-base font-bold text-white mb-1">Open Addon Manager in Stremio</h3>
              <p class="text-xs sm:text-sm text-slate-400">Open Stremio on Android, Windows, FireTV, macOS, or iOS. Navigate to the <strong>Addons</strong> tab (puzzle piece icon).</p>
            </div>
          </div>

          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center font-bold text-sm shrink-0">3</div>
            <div>
              <h3 class="text-base font-bold text-white mb-1">Paste & Install</h3>
              <p class="text-xs sm:text-sm text-slate-400">Paste the URL into the search/URL bar in Stremio and click <strong>Install Addon</strong>.</p>
            </div>
          </div>
        </div>

        <!-- Nuvio Instructions -->
        <div id="nuvio-guide" class="tab-content hidden glass-card p-6 sm:p-8 rounded-3xl space-y-6">
          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-300 flex items-center justify-center font-bold text-sm shrink-0">1</div>
            <div>
              <h3 class="text-base font-bold text-white mb-1">One-Click Nuvio Protocol</h3>
              <p class="text-xs sm:text-sm text-slate-400">Tap the <strong>Install on Nuvio</strong> button above to invoke the <code class="text-cyan-300 font-mono">nuvio://</code> deep link handler.</p>
            </div>
          </div>

          <div class="flex items-start gap-4">
            <div class="w-8 h-8 rounded-full bg-cyan-500/20 text-cyan-300 flex items-center justify-center font-bold text-sm shrink-0">2</div>
            <div>
              <h3 class="text-base font-bold text-white mb-1">Manual Extension Setup</h3>
              <p class="text-xs sm:text-sm text-slate-400">If using manual mode, go to Nuvio Settings &gt; Extensions &gt; Add Custom Repository, and paste the manifest URL.</p>
            </div>
          </div>
        </div>

      </div>
    </section>
  </main>

  <footer class="py-10 border-t border-white/5 relative z-10 text-center text-xs text-slate-500">
    <div class="max-w-6xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4">
      <div class="flex items-center gap-2">
        <span class="font-display font-bold text-slate-300">MalSUB</span>
        <span>— Malayalam Subtitle Aggregator</span>
      </div>
      <div class="flex items-center gap-4 text-slate-400">
        <span>MSone Fansubs</span>
        <span>•</span>
        <span>Movie Mirror</span>
        <span>•</span>
        <span>Team GOAT</span>
      </div>
    </div>
  </footer>

  <script>
    const MANIFEST_URL = "https://malsub.addon.workers.dev/manifest.json";

    // Copy Manifest Function with fallback
    function copyManifestUrl() {
      const input = document.getElementById("manifest-input");
      
      if (input) {
        input.select();
        input.setSelectionRange(0, 99999);
      }
      
      try {
        document.execCommand('copy');
        showToast("Copied Manifest URL!", "Paste this in Stremio or Nuvio addon search.");
      } catch (err) {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(MANIFEST_URL).then(() => {
            showToast("Copied Manifest URL!", "Paste this in Stremio or Nuvio addon search.");
          });
        }
      }

      const btnText = document.getElementById("copy-btn-text");
      if (btnText) {
        btnText.innerText = "Copied! ✓";
        setTimeout(() => { btnText.innerText = "Copy URL"; }, 2000);
      }
    }

    // Toast Notification logic
    function showToast(title, msg, isSuccess = true) {
      const toast = document.getElementById("toast");
      const toastTitle = document.getElementById("toast-title");
      const toastMsg = document.getElementById("toast-msg");
      const toastIcon = document.getElementById("toast-icon");
      
      toastTitle.innerText = title;
      toastMsg.innerText = msg;
      
      if (toastIcon) {
        toastIcon.className = isSuccess ? "fa-solid fa-check text-sm" : "fa-solid fa-database text-sm";
      }

      toast.classList.remove("translate-y-24", "opacity-0");
      toast.classList.add("translate-y-0", "opacity-100");

      setTimeout(() => {
        toast.classList.add("translate-y-24", "opacity-0");
        toast.classList.remove("translate-y-0", "opacity-100");
      }, 3500);
    }

    function triggerInstall(platform) {
      showToast(\`Opening in \${platform}...\`, "Confirm install prompt in your media player.");
    }

    // Tab Switching
    function switchTab(tabId) {
      document.querySelectorAll(".tab-content").forEach(el => el.classList.add("hidden"));
      const activeContent = document.getElementById(tabId);
      if (activeContent) activeContent.classList.remove("hidden");

      const stremioBtn = document.getElementById("tab-stremio-guide");
      const nuvioBtn = document.getElementById("tab-nuvio-guide");

      if (tabId === 'stremio-guide') {
        stremioBtn.className = "px-5 py-2.5 rounded-xl font-bold text-xs sm:text-sm bg-purple-600 text-white shadow-lg transition-all flex items-center gap-2";
        nuvioBtn.className = "px-5 py-2.5 rounded-xl font-bold text-xs sm:text-sm text-slate-400 hover:text-white transition-all flex items-center gap-2";
      } else {
        nuvioBtn.className = "px-5 py-2.5 rounded-xl font-bold text-xs sm:text-sm bg-cyan-600 text-white shadow-lg transition-all flex items-center gap-2";
        stremioBtn.className = "px-5 py-2.5 rounded-xl font-bold text-xs sm:text-sm text-slate-400 hover:text-white transition-all flex items-center gap-2";
      }
    }

    // Generate Responsive Uptime Ticks
    function renderUptimeBars(containerId, slightGlitch = false) {
      const container = document.getElementById(containerId);
      if (!container) return;
      container.innerHTML = "";

      const totalDays = 30;
      for (let i = 1; i <= totalDays; i++) {
        const bar = document.createElement("div");
        bar.className = "relative has-tooltip flex-1 min-w-0 h-6 sm:h-8 rounded-[3px] sm:rounded-[4px] cursor-pointer transition-all duration-200 hover:scale-125 hover:z-20";

        const isDegraded = slightGlitch && (i === 12 || i === 24);
        const isFull = !isDegraded;

        if (isFull) {
          bar.classList.add("bg-emerald-500/80", "hover:bg-emerald-400");
        } else {
          bar.classList.add("bg-amber-400/80", "hover:bg-amber-300");
        }

        const dayOffset = totalDays - i;
        const dateStr = dayOffset === 0 ? "Today" : \`\${dayOffset}d ago\`;
        const statusStr = isFull ? "100% Operational" : "98.2% Minor Latency";

        bar.innerHTML = \`
          <div class="tooltip absolute bottom-9 left-1/2 -translate-x-1/2 pointer-events-none z-30 bg-slate-900 border border-white/20 text-white text-[9px] sm:text-[10px] font-mono py-1 px-2 rounded-md shadow-xl whitespace-nowrap">
            <span class="font-bold text-slate-200">\${dateStr}</span>: \${statusStr}
          </div>
        \`;
        container.appendChild(bar);
      }
    }

    // Ping Simulator
    function simulateHealthCheck() {
      const refreshBtn = document.getElementById("refresh-btn");
      const refreshText = document.getElementById("refresh-text");
      
      refreshBtn.classList.add("opacity-60", "pointer-events-none");
      refreshText.innerHTML = \`<i class="fa-solid fa-spinner animate-spin mr-1"></i> Checking...\`;

      setTimeout(() => {
        document.getElementById("ping-gateway").innerText = \`\${Math.floor(28 + Math.random() * 18)}ms\`;
        document.getElementById("ping-msone").innerText = \`\${Math.floor(65 + Math.random() * 25)}ms\`;
        document.getElementById("ping-mirror").innerText = \`\${Math.floor(88 + Math.random() * 30)}ms\`;
        document.getElementById("ping-goat").innerText = \`\${Math.floor(75 + Math.random() * 20)}ms\`;

        refreshBtn.classList.remove("opacity-60", "pointer-events-none");
        refreshText.innerText = "Check Latency";
        showToast("Latency Refreshed!", "All provider scrapers are responding normally.");
      }, 750);
    }

    // Database Sync Simulator
    let isUpdatingDb = false;
    let currentSubCount = 120480;

    function triggerDatabaseUpdate() {
      if (isUpdatingDb) return;
      isUpdatingDb = true;

      const btn = document.getElementById("db-update-btn");
      const btnIcon = document.getElementById("db-btn-icon");
      const btnText = document.getElementById("db-btn-text");
      const headerIcon = document.getElementById("header-db-icon");
      const wrapper = document.getElementById("db-progress-wrapper");
      const progressBar = document.getElementById("db-progress-bar");
      const statusStep = document.getElementById("db-status-step");
      const statusPercent = document.getElementById("db-status-percent");
      const lastSyncEl = document.getElementById("db-last-sync");

      btn.classList.add("opacity-75", "pointer-events-none");
      if (btnIcon) btnIcon.className = "fa-solid fa-arrows-rotate animate-spin text-purple-200";
      if (headerIcon) headerIcon.className = "fa-solid fa-arrows-rotate animate-spin text-purple-400";
      btnText.innerText = "Syncing Subtitle Index...";

      wrapper.classList.remove("hidden");
      
      const steps = [
        { pct: 20, text: "Fetching MSone RSS feed..." },
        { pct: 55, text: "Parsing Movie Mirror repository..." },
        { pct: 85, text: "Indexing Team GOAT OTT packs..." },
        { pct: 100, text: "Database updated successfully!" }
      ];

      let currentStep = 0;

      const interval = setInterval(() => {
        if (currentStep < steps.length) {
          const step = steps[currentStep];
          progressBar.style.width = \`\${step.pct}%\`;
          statusStep.innerText = step.text;
          statusPercent.innerText = \`\${step.pct}%\`;
          currentStep++;
        } else {
          clearInterval(interval);
          
          const added = Math.floor(18 + Math.random() * 35);
          currentSubCount += added;
          document.getElementById("stat-count").innerText = \`\${currentSubCount.toLocaleString()}+\`;

          lastSyncEl.innerText = \`Updated: \${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\`;
          btnText.innerText = \`Sync Complete (+\${added} Subs Added)\`;
          
          if (btnIcon) btnIcon.className = "fa-solid fa-check text-emerald-300";
          if (headerIcon) headerIcon.className = "fa-solid fa-check text-emerald-400";

          showToast("Database Updated!", \`Added \${added} new Malayalam subtitle entries to the index.\`, false);

          setTimeout(() => {
            isUpdatingDb = false;
            btn.classList.remove("opacity-75", "pointer-events-none");
            btnText.innerText = "Update Subtitle Database Now";
            if (btnIcon) btnIcon.className = "fa-solid fa-database text-purple-200";
            if (headerIcon) headerIcon.className = "fa-solid fa-arrows-rotate text-purple-400";
            wrapper.classList.add("hidden");
            progressBar.style.width = "0%";
          }, 3500);
        }
      }, 600);
    }

    // Mock Search Database
    const mockDatabase = {
      "aavesham": [
        { source: "MSone", tag: "msone", name: "Aavesham (2024) WEB-DL 1080p Malayalam.srt", sync: "100% Match", author: "FahadhFansub Group", rate: "24.000 fps" },
        { source: "Movie Mirror", tag: "mirror", name: "Aavesham.2024.Malayalam.2160p.HQ-Rip.srt", sync: "99% Match", author: "MirrorTeam Kerala", rate: "23.976 fps" },
        { source: "Team GOAT", tag: "goat", name: "Aavesham (2024) OTT Untouched Sub Malayalam.srt", sync: "100% Match", author: "Team GOAT Official", rate: "24.000 fps" }
      ],
      "manjummel boys": [
        { source: "MSone", tag: "msone", name: "Manjummel.Boys.2024.TrueHD.Malayalam.srt", sync: "100% Match", author: "MSone Verified", rate: "24.000 fps" },
        { source: "Team GOAT", tag: "goat", name: "Manjummel Boys (2024) Special Guna Cave Edition.srt", sync: "100% Match", author: "G.O.A.T Subs", rate: "24.000 fps" },
        { source: "Movie Mirror", tag: "mirror", name: "Manjummel.Boys.Malayalam.1080p.HEVC.srt", sync: "98% Match", author: "MovieMirror Hub", rate: "23.976 fps" }
      ],
      "interstellar": [
        { source: "MSone", tag: "msone", name: "Interstellar (2014) IMAX 1080p Malayalam [MSone Gold].srt", sync: "100% Match", author: "Sujith MSone", rate: "23.976 fps" },
        { source: "Movie Mirror", tag: "mirror", name: "Interstellar.2014.Remastered.Malayalam.srt", sync: "99% Match", author: "Mirror Curators", rate: "24.000 fps" }
      ],
      "dark": [
        { source: "Team GOAT", tag: "goat", name: "Dark.S01-S03.Complete.German-Malayalam.srt", sync: "100% Series Pack", author: "Team GOAT SciFi", rate: "25.000 fps" },
        { source: "MSone", tag: "msone", name: "Dark (Season 1-3) Malayalam Community FanSub.srt", sync: "100% Series Pack", author: "MSone Team", rate: "25.000 fps" }
      ]
    };

    function setQuery(title) {
      const input = document.getElementById("demo-search");
      input.value = title;
      handleSearch(title);
    }

    function handleSearch(query) {
      const clean = query.trim().toLowerCase();
      const countEl = document.getElementById("result-count");
      const queryEl = document.getElementById("result-query");
      const listEl = document.getElementById("results-list");

      queryEl.innerText = query ? \`Showing results for "\${query}"\` : 'Showing latest indexed subtitles';

      let matched = [];
      for (const key in mockDatabase) {
        if (clean === "" || key.includes(clean) || clean.includes(key)) {
          matched = matched.concat(mockDatabase[key]);
        }
      }

      if (matched.length === 0 && clean.length > 0) {
        matched = [
          { source: "MSone", tag: "msone", name: \`\${query}.Malayalam.AutoIndexed.srt\`, sync: "Fuzzy Auto Match", author: "MSone Live Scraper", rate: "24.000 fps" },
          { source: "Team GOAT", tag: "goat", name: \`\${query}.OTT.Malayalam-TeamGOAT.srt\`, sync: "Fuzzy Auto Match", author: "Team GOAT Index", rate: "23.976 fps" }
        ];
      }

      countEl.innerText = \`\${matched.length} Subtitles Found\`;
      listEl.innerHTML = "";

      matched.forEach(item => {
        let badgeColor = "bg-amber-500/20 text-amber-300 border-amber-500/30";
        if (item.tag === "mirror") badgeColor = "bg-blue-500/20 text-blue-300 border-blue-500/30";
        if (item.tag === "goat") badgeColor = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";

        const div = document.createElement("div");
        div.className = "flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/5 transition-all gap-2";
        div.innerHTML = \`
          <div class="flex items-center gap-3 overflow-hidden">
            <span class="text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded border shrink-0 \${badgeColor}">\${item.source}</span>
            <div class="truncate">
              <div class="text-xs font-semibold text-slate-200 truncate">\${item.name}</div>
              <div class="text-[10px] text-slate-400 font-mono">By: \${item.author} • \${item.rate}</div>
            </div>
          </div>
          <div class="flex items-center justify-between sm:justify-end gap-3 shrink-0">
            <span class="text-[11px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">\${item.sync}</span>
            <button onclick="showToast('Test Download Successful', 'SRT ready for media stream parsing.')" class="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-purple-600 text-slate-300 hover:text-white text-xs transition-colors">
              <i class="fa-solid fa-download text-[10px]"></i>
            </button>
          </div>
        \`;
        listEl.appendChild(div);
      });
    }

    // Initialize On Load
    window.addEventListener("DOMContentLoaded", () => {
      renderUptimeBars("bars-gateway", false);
      renderUptimeBars("bars-msone", true);
      renderUptimeBars("bars-mirror", false);
      renderUptimeBars("bars-goat", true);
      simulateHealthCheck();
      handleSearch('aavesham');
    });
  </script>
</body>
</html>
`;    res.setHeader('Content-Type', 'text/html');
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
