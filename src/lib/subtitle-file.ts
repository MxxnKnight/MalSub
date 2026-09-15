const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function driveDirect(url: string) {
  const id =
    url.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] ??
    url.match(/[?&]id=([a-zA-Z0-9_-]+)/)?.[1];
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
}

export function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
  };
}

export async function findSubtitleFile(pageUrl: string): Promise<string | null> {
  const pages = [pageUrl];
  if (!pageUrl.endsWith("/")) pages.push(`${pageUrl}/`);
  for (const url of pages) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const files =
        html.match(/https?:\/\/[^"'<\s]+?\.(?:srt|vtt|ass)(?:\?[^"'<\s]*)?/gi) ??
        [];
      if (files[0]) return files[0];
      const drive = html.match(/https?:\/\/drive\.google\.com\/[^"'<\s]+/i);
      if (drive?.[0]) return driveDirect(drive[0]);
      const upload = html.match(
        /https?:\/\/[^"'<\s]*wp-content\/uploads\/[^"'<\s]+\.(?:srt|vtt|zip)/i,
      );
      if (upload?.[0]) return upload[0];
    } catch {
      // try next
    }
  }
  return null;
}
