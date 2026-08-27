const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const AdmZip = require('adm-zip');

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

// Helper: Convert IMDb ID to title
async function getMeta(id, type) {
    const imdbId = id.split(':')[0];
    try {
        const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
        if (res.data && res.data.meta) {
            const meta = res.data.meta;
            const yearStr = meta.year || meta.releaseInfo;
            let parsedYear = null;
            if (yearStr) {
                const match = String(yearStr).match(/\d{4}/);
                if (match) parsedYear = match[0];
            }
            return {
                title: meta.name,
                year: parsedYear
            };
        }
    } catch (e) {
        console.error("Cinemeta fetch error:", e.message);
    }
    return null;
}

// Deep Scrape: Find the actual download link from a post page
async function findDownloadLink(postUrl) {
    try {
        const { data } = await axios.get(postUrl);
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

async function searchSite(title, urlTemplate, siteName) {
    const results = [];
    try {
        const searchUrl = urlTemplate.replace('{query}', encodeURIComponent(title));
        const { data } = await axios.get(searchUrl);
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
                    name: `${siteName} - ${topResult.name}`,
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
    
    let url;
    if (type === 'series' && season) {
        url = `https://malayalamsubtitles.in/release/${slug}-season${season}-${meta.year}/`;
    } else {
        url = `https://malayalamsubtitles.in/release/${slug}-${meta.year}/`;
    }
    
    try {
        const dlLink = await findDownloadLink(url);
        if (dlLink) {
            return {
                id: 'TeamGOAT_' + encodeURIComponent(meta.title),
                url: dlLink,
                lang: 'Malayalam',
                name: `TeamGOAT - ${meta.title}`,
                title: "Team GOAT"
            };
        }
    } catch (e) {}
    
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
                name: `TeamGOAT - ${meta.title}`,
                title: "Team GOAT"
            };
        }
    } catch (e) {}

    return null;
}

async function searchMovieMirror(title) {
    try {
        const searchUrl = `https://moviemirrorsubtitles.com/wp-json/wp/v2/posts?search=${encodeURIComponent(title)}`;
        const { data } = await axios.get(searchUrl);
        
        if (data && data.length > 0) {
            const postUrl = data[0].link;
            const dlLink = await findDownloadLink(postUrl);
            if (dlLink) {
                return {
                    id: 'MovieMirror_' + encodeURIComponent(title),
                    url: dlLink,
                    lang: 'Malayalam',
                    name: `MovieMirror - ${title}`,
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
    const meta = await getMeta(id, type);
    
    if (!meta || !meta.title) return { subtitles: [] };
    
    const [msone, goat, mirror] = await Promise.all([
        searchSite(meta.title, 'https://malayalamsubtitles.org/?s={query}', 'MSone'),
        searchTeamGoat(meta, type, id),
        searchMovieMirror(meta.title)
    ]);
    
    const subtitles = [];
    for (let sub of [msone, goat, mirror]) {
        if (sub) {
            // If the link is a zip, point it to our extraction endpoint
            if (sub.url.endsWith('.zip') || !sub.url.endsWith('.srt')) {
                const fakeFilename = encodeURIComponent((sub.title || 'Subtitle') + '.srt');
                let extractParams = `url=${encodeURIComponent(sub.url)}`;
                
                const seasonMatch = id.match(/:(\d+):(\d+)$/);
                if (seasonMatch) {
                    extractParams += `&season=${seasonMatch[1]}&episode=${seasonMatch[2]}`;
                }
                
                sub.url = `${globalBaseUrl}/extract/${fakeFilename}?${extractParams}`;
            }
            subtitles.push(sub);
        }
    }
    
    return Promise.resolve({ subtitles: subtitles });
});

const app = express();
const addonInterface = builder.getInterface();

// Middleware to capture BASE_URL for Nuvio/Stremio responses
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    
    if (req.get('host')) {
        globalBaseUrl = `${req.protocol}://${req.get('host')}`;
    }
    next();
});

// Extraction Endpoint: Unzip on the fly
app.get(['/extract', '/extract/:filename'], async (req, res) => {
    const fileUrl = req.query.url;
    console.log("EXTRACT REQUEST FOR:", fileUrl);
    if (!fileUrl) return res.status(400).send("Missing url");

    try {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        
        // If it's already an SRT, just send it
        if (fileUrl.endsWith('.srt') || fileUrl.endsWith('.vtt')) {
            res.setHeader('Content-Type', 'text/plain');
            return res.send(response.data);
        }

        console.log("Attempting to unzip. Received bytes:", response.data.length);
        const header = response.data.toString('utf8', 0, Math.min(50, response.data.length));
        console.log("Header preview:", header);

        // Check if the downloaded content is actually an SRT or VTT (sometimes returned directly without .srt in URL)
        if (header.trim().startsWith('1\r\n') || header.trim().startsWith('1\n') || header.trim().startsWith('WEBVTT')) {
            console.log("Content is raw SRT/VTT, bypassing unzip!");
            res.setHeader('Content-Type', 'text/plain');
            return res.send(response.data);
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
                res.setHeader('Content-Type', 'text/plain');
                res.send(bestEntry.getData().toString('utf8'));
            } else {
                console.log("No subtitle found in zip for:", fileUrl);
                res.status(404).send("No subtitle found in zip");
            }
        } catch(zipError) {
            console.log("Failed to unzip. It might not be a zip file. Returning raw data as fallback.");
            res.setHeader('Content-Type', 'text/plain');
            return res.send(response.data);
        }
    } catch (e) {
        console.error("Extraction error:", e.message);
        res.status(500).send("Error extracting subtitle");
    }
});

const addonRouter = require('stremio-addon-sdk/src/getRouter')(addonInterface);
app.use('/', addonRouter);

const port = process.env.PORT || 7000;
app.listen(port, () => {
    console.log(`Addon is running at http://localhost:${port}/manifest.json`);
});
