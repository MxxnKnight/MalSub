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

// Deep Scrape: Find the actual download link from a post page
async function findDownloadLink(postUrl) {
    try {
        const { data } = await httpClient.get(postUrl);
        const $ = cheerio.load(data);
        let downloadLink = null;
        
        // Strategy 1: Look for WordPress Download Manager links (used by MSone)
        const wpdmdlMatch = data.match(/\?wpdmdl=\d+/);
        if (wpdmdlMatch) {
            const urlObj = new URL(postUrl);
            return `${urlObj.protocol}//${urlObj.host}/${wpdmdlMatch[0]}`;
        }
        
        // Strategy 2: Look for specific download path (used by TeamGOAT)
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

async function searchSite(title, urlTemplate, siteName, season = null) {
    const results = [];
    try {
        let query = title;
        if (season) query += ` Season ${season}`;
        const searchUrl = urlTemplate.replace('{query}', encodeURIComponent(query));
        const { data } = await httpClient.get(searchUrl);
        const $ = cheerio.load(data);
        
        $('a').each((i, el) => {
            const text = $(el).text().toLowerCase();
            const href = $(el).attr('href');
            if (href && text.includes(title.toLowerCase()) && !href.includes('?s=')) {
                results.push({ url: href, name: text.trim() });
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
        
        const topResult = unique[0];
        if (topResult) {
            const dlLink = await findDownloadLink(topResult.url);
            if (dlLink) {
                return {
                    id: siteName + '_' + encodeURIComponent(title),
                    url: dlLink,
                    lang: 'Malayalam',
                    name: `[MSone] Malayalam - ${topResult.name}`,
                    title: siteName
                };
            }
        }
    } catch (e) {
        console.error(`${siteName} error:`, e.message);
    }
    return null;
}

async function searchTeamGoat(meta, type, id) {
    const seasonMatch = id.match(/:(\d+):\d+$/);
    const season = seasonMatch ? seasonMatch[1] : null;
    
    function toSlug(text) {
        return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    const slug = toSlug(meta.title);
    
    // Strategy 1: Direct Slug with Year
    let url = type === 'series' && season ? 
        `https://malayalamsubtitles.in/release/${slug}-season${season}-${meta.year}/` :
        `https://malayalamsubtitles.in/release/${slug}-${meta.year}/`;
    
    try {
        const dlLink = await findDownloadLink(url);
        if (dlLink) {
            return {
                id: 'TeamGOAT_' + encodeURIComponent(meta.title),
                url: dlLink,
                lang: 'Malayalam',
                name: `[TeamGOAT] Malayalam - ${meta.title}`,
                title: "Team GOAT"
            };
        }
    } catch (e) {}
    
    // Strategy 2: Direct Slug without Year
    try {
        let fallbackUrl = type === 'series' && season ? 
            `https://malayalamsubtitles.in/release/${slug}-season${season}/` :
            `https://malayalamsubtitles.in/release/${slug}/`;
        const dlLink = await findDownloadLink(fallbackUrl);
        if (dlLink) {
            return {
                id: 'TeamGOAT_' + encodeURIComponent(meta.title),
                url: dlLink,
                lang: 'Malayalam',
                name: `[TeamGOAT] Malayalam - ${meta.title}`,
                title: "Team GOAT"
            };
        }
    } catch (e) {}

    // Strategy 3: Site Search Fallback if direct slugs fail
    try {
        const searchUrl = `https://malayalamsubtitles.in/?s=${encodeURIComponent(meta.title)}`;
        const { data } = await httpClient.get(searchUrl);
        const $ = cheerio.load(data);
        
        let matchUrl = null;
        let matchName = meta.title;
        
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (href && href.includes('/release/') && text.includes(meta.title.toLowerCase())) {
                matchUrl = href;
                if ($(el).text().trim()) matchName = $(el).text().trim();
            }
        });
        
        if (matchUrl) {
            if (!matchUrl.startsWith('http')) {
                matchUrl = `https://malayalamsubtitles.in${matchUrl.startsWith('/') ? '' : '/'}${matchUrl}`;
            }
            const dlLink = await findDownloadLink(matchUrl);
            if (dlLink) {
                return {
                    id: 'TeamGOAT_' + encodeURIComponent(meta.title),
                    url: dlLink,
                    lang: 'Malayalam',
                    name: `[TeamGOAT] Malayalam - ${matchName}`,
                    title: "Team GOAT"
                };
            }
        }
    } catch (e) {
        console.error("TeamGOAT search fallback error:", e.message);
    }

    return null;
}

async function searchMovieMirror(title, season = null) {
    try {
        let query = title;
        if (season) query += ` Season ${season}`;
        const searchUrl = `https://moviemirrorsubtitles.com/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}`;
        const { data } = await httpClient.get(searchUrl);
        
        if (data && data.length > 0) {
            const postUrl = data[0].link;
            const dlLink = await findDownloadLink(postUrl);
            if (dlLink) {
                return {
                    id: 'MovieMirror_' + encodeURIComponent(title),
                    url: dlLink,
                    lang: 'Malayalam',
                    name: `[Movie Mirror] Malayalam - ${title}`,
                    title: "Movie Mirror"
                };
            }
        }
    } catch (e) {
        console.error("MovieMirror error:", e.message);
    }
    return null;
}

let globalBaseUrl = 'http://localhost:7000'; // Default, overridden in Express

builder.defineSubtitlesHandler(async function(args) {
    const { type, id } = args;
    const cacheKey = `sub_${type}_${id}`;
    const cached = subCache.get(cacheKey);
    if (cached) return Promise.resolve({ subtitles: cached });

    const meta = await getMeta(id, type);
    if (!meta || !meta.title) return { subtitles: [] };

    const seasonMatch = id.match(/:(\d+):(\d+)$/);
    const season = seasonMatch ? seasonMatch[1] : null;
    
    const [msone, goat, mirror] = await Promise.all([
        searchSite(meta.title, 'https://malayalamsubtitles.org/?s={query}', 'MSone', season),
        searchTeamGoat(meta, type, id),
        searchMovieMirror(meta.title, season)
    ]);
    
    const subtitles = [];
    for (let sub of [msone, goat, mirror]) {
        if (sub) {
            // Copy sub object so original URL is preserved
            const subCopy = { ...sub };
            if (subCopy.url.endsWith('.zip') || !subCopy.url.endsWith('.srt')) {
                const fakeFilename = encodeURIComponent((subCopy.title || 'Subtitle') + '.srt');
                let extractParams = `url=${encodeURIComponent(subCopy.url)}`;
                
                const seasonMatch = id.match(/:(\d+):(\d+)$/);
                if (seasonMatch) {
                    extractParams += `&season=${seasonMatch[1]}&episode=${seasonMatch[2]}`;
                }
                
                subCopy.url = `${globalBaseUrl}/extract/${fakeFilename}?${extractParams}`;
            }
            subtitles.push(subCopy);
        }
    }
    
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
            --bg: #0b0f19;
            --card-bg: rgba(255, 255, 255, 0.05);
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --text: #f8fafc;
            --text-muted: #94a3b8;
            --accent: #22c55e;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            background: var(--card-bg);
            backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 40px;
            max-width: 480px;
            width: 100%;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        }
        .badge-logo {
            display: inline-block;
            background: linear-gradient(135deg, #6366f1, #a855f7);
            color: white;
            font-weight: 800;
            font-size: 1.2rem;
            padding: 10px 20px;
            border-radius: 12px;
            margin-bottom: 20px;
        }
        h1 { margin: 0 0 10px 0; font-size: 1.8rem; font-weight: 700; }
        p { color: var(--text-muted); font-size: 0.95rem; line-height: 1.5; margin-bottom: 25px; }
        .providers {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin-bottom: 30px;
            flex-wrap: wrap;
        }
        .provider-tag {
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 0.82rem;
            font-weight: 600;
            color: #cbd5e1;
        }
        .provider-tag.active { border-color: var(--accent); color: #4ade80; }
        .btn {
            display: block;
            width: 100%;
            padding: 14px;
            background: var(--primary);
            color: white;
            text-decoration: none;
            font-weight: 600;
            border-radius: 12px;
            box-sizing: border-box;
            transition: all 0.2s ease;
            font-size: 1rem;
            margin-bottom: 12px;
        }
        .btn:hover { background: var(--primary-hover); transform: translateY(-2px); }
        .btn-secondary {
            background: transparent;
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: var(--text);
            cursor: pointer;
        }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.1); }
        .footer { font-size: 0.8rem; color: #64748b; margin-top: 25px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="badge-logo">MalSUB</div>
        <h1>Malayalam Subtitles</h1>
        <p>Malayalam subtitles for Nuvio App and Stremio sourced directly from MSone, TeamGOAT, and Movie Mirror.</p>
        
        <div class="providers">
            <span class="provider-tag active">● MSone</span>
            <span class="provider-tag active">● TeamGOAT</span>
            <span class="provider-tag active">● Movie Mirror</span>
        </div>

        <a href="${stremioUrl}" class="btn">🚀 Install in Nuvio / Stremio</a>
        <button class="btn btn-secondary" onclick="navigator.clipboard.writeText('${manifestUrl}'); alert('Manifest URL copied to clipboard!');">📋 Copy Manifest URL</button>

        <div class="footer">Status: Online | v1.0.0</div>
    </div>
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

