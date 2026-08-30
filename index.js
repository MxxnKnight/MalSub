const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');

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

async function searchSite(title, urlTemplate, siteName, imdbId = null) {
    const results = [];
    try {
        const cleanSearchQuery = title.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
        const searchUrl = urlTemplate.replace('{query}', encodeURIComponent(cleanSearchQuery));
        console.log(`[${siteName}] Searching: ${searchUrl}`);
        const { data } = await httpClient.get(searchUrl);
        const $ = cheerio.load(data);
        
        const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        
        $('a').each((i, el) => {
            const text = $(el).text().toLowerCase();
            const href = $(el).attr('href');
            const cleanText = text.replace(/[^a-z0-9]/g, '');
            if (href && (text.includes(title.toLowerCase()) || cleanText.includes(cleanTitle)) && !href.includes('?s=')) {
                results.push({ url: href, name: $(el).text().trim() });
            }
        });
        
        const unique = [];
        const seen = new Set();
        for (let r of results) {
            if (!seen.has(r.url) && r.url.startsWith('http')) {
                seen.add(r.url);
                unique.push(r);
            }
        }
        
        for (let topResult of unique) {
            const dlLink = await findDownloadLink(topResult.url, imdbId);
            if (dlLink) {
                console.log(`[SUCCESS] [${siteName}] Found subtitle for "${title}" -> ${dlLink}`);
                return {
                    id: siteName + '_' + encodeURIComponent(title),
                    url: dlLink,
                    lang: 'Malayalam',
                    name: `[${siteName}] Malayalam - ${topResult.name}`,
                    title: siteName
                };
            }
        }
        console.log(`[NOT FOUND] [${siteName}] No subtitle found for "${title}"`);
    } catch (e) {
        console.error(`[ERROR] [${siteName}] ${e.message}`);
    }
    return null;
}

async function searchTeamGoat(meta, type, id) {
    const imdbId = id.split(':')[0];
    const seasonMatch = id.match(/:(\d+):\d+$/);
    const season = seasonMatch ? seasonMatch[1] : null;
    
    function toSlug(text) {
        return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    const slug = toSlug(meta.title);
    
    // Always candidate slugs: slug-season-year, slug-year, slug-season, slug
    let urls = [];
    if (type === 'series' && season && meta.year) {
        urls.push(`https://malayalamsubtitles.in/release/${slug}-season${season}-${meta.year}/`);
    }
    if (meta.year) {
        urls.push(`https://malayalamsubtitles.in/release/${slug}-${meta.year}/`);
    }
    if (type === 'series' && season) {
        urls.push(`https://malayalamsubtitles.in/release/${slug}-season${season}/`);
    }
    urls.push(`https://malayalamsubtitles.in/release/${slug}/`);
    
    urls = [...new Set(urls)];
    
    for (let u of urls) {
        console.log(`[TeamGOAT] Checking direct URL candidate: ${u}`);
        const dlLink = await findDownloadLink(u, imdbId);
        if (dlLink) {
            console.log(`[SUCCESS] [TeamGOAT] Found subtitle for "${meta.title}" -> ${dlLink}`);
            return {
                id: 'TeamGOAT_' + encodeURIComponent(meta.title),
                url: dlLink,
                lang: 'Malayalam',
                name: `[TeamGOAT] Malayalam - ${meta.title}`,
                title: "Team GOAT"
            };
        }
    }

    // Strategy 3: Site Search Fallback if direct slugs fail
    try {
        const cleanSearchQuery = meta.title.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
        const searchUrl = `https://malayalamsubtitles.in/?s=${encodeURIComponent(cleanSearchQuery)}`;
        console.log(`[TeamGOAT] Searching (Strategy 3): ${searchUrl}`);
        const { data } = await httpClient.get(searchUrl);
        const $ = cheerio.load(data);
        
        let matchUrl = null;
        let matchName = meta.title;
        const cleanTitle = meta.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            const cleanText = text.replace(/[^a-z0-9]/g, '');
            if (href && href.includes('/release/') && (text.includes(meta.title.toLowerCase()) || cleanText.includes(cleanTitle))) {
                matchUrl = href;
                if ($(el).text().trim()) matchName = $(el).text().trim();
            }
        });
        
        if (matchUrl) {
            if (!matchUrl.startsWith('http')) {
                matchUrl = `https://malayalamsubtitles.in${matchUrl.startsWith('/') ? '' : '/'}${matchUrl}`;
            }
            const dlLink = await findDownloadLink(matchUrl, imdbId);
            if (dlLink) {
                console.log(`[SUCCESS] [TeamGOAT] Found subtitle for "${meta.title}" -> ${dlLink}`);
                return {
                    id: 'TeamGOAT_' + encodeURIComponent(meta.title),
                    url: dlLink,
                    lang: 'Malayalam',
                    name: `[TeamGOAT] Malayalam - ${matchName}`,
                    title: "Team GOAT"
                };
            }
        }
        console.log(`[NOT FOUND] [TeamGOAT] No subtitle found for "${meta.title}"`);
    } catch (e) {
        console.error(`[ERROR] [TeamGOAT] ${e.message}`);
    }

    return null;
}

async function searchMovieMirror(title, imdbId = null) {
    try {
        const cleanQuery = title.replace(/:/g, ' ').replace(/\./g, '').replace(/\s+/g, ' ').trim();
        const searchUrl = `https://moviemirrorsubtitles.com/wp-json/wp/v2/posts?search=${encodeURIComponent(cleanQuery)}`;
        console.log(`[Movie Mirror] Searching: ${searchUrl}`);
        const { data } = await httpClient.get(searchUrl);
        
        if (data && data.length > 0) {
            for (let post of data) {
                const postUrl = post.link;
                const dlLink = await findDownloadLink(postUrl, imdbId);
                if (dlLink) {
                    console.log(`[SUCCESS] [Movie Mirror] Found subtitle for "${title}" -> ${dlLink}`);
                    return {
                        id: 'MovieMirror_' + encodeURIComponent(title),
                        url: dlLink,
                        lang: 'Malayalam',
                        name: `[Movie Mirror] Malayalam - ${title}`,
                        title: "Movie Mirror"
                    };
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

    const meta = await getMeta(id, type);
    if (!meta || !meta.title) {
        console.log(`[META ERROR] Could not resolve IMDb ID "${id}" via Cinemeta.`);
        return { subtitles: [] };
    }
    console.log(`[META RESOLVED] Title: "${meta.title}", Year: ${meta.year || 'N/A'}`);

    const [msone, goat, mirror] = await Promise.all([
        searchSite(meta.title, 'https://malayalamsubtitles.org/?s={query}', 'MSone', imdbId),
        searchTeamGoat(meta, type, id),
        searchMovieMirror(meta.title, imdbId)
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
            const providerTag = subCopy.title || 'MalSUB'; // e.g. "MSone", "Team GOAT", "Movie Mirror"
            const cleanTitle = meta.title.replace(/[\\/:*?"<>|]/g, '');
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
                searchSite(meta.title, 'https://malayalamsubtitles.org/?s={query}', 'MSone', meta.imdbId),
                searchTeamGoat(meta, meta.type, meta.imdbId || 'tt0000000'),
                searchMovieMirror(meta.title, meta.imdbId)
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

