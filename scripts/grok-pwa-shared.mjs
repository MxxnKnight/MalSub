export function acceptsHtml(accept) {
  if (!accept) return true;
  return accept.includes("text/html") || accept.includes("*/*");
}

export function isDocumentPath(path) {
  if (!path || path === "/") return true;
  if (path.startsWith("/api") || path.startsWith("/subtitles")) return false;
  if (path.includes(".")) {
    return !/\.(js|css|json|png|jpg|jpeg|svg|ico|webp|woff2?|map)$/i.test(path);
  }
  return true;
}

export function isInstallQuery(urlWithQuery) {
  return /[?&]install=1(?:&|$)/.test(urlWithQuery);
}

export function renderWebManifest(host) {
  const origin = host.startsWith("http") ? host : `https://${host}`;
  return JSON.stringify({
    name: "MalSUB",
    short_name: "MalSUB",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [{ src: `${origin}/addon-logo.svg`, sizes: "any", type: "image/svg+xml" }],
  });
}

export function renderInstallPageHtml(template, { host }) {
  return String(template || "")
    .replaceAll("{{HOST}}", host || "")
    .replaceAll("{{NAME}}", "MalSUB");
}

export function createHeadInjector({ host, site }) {
  const name = site?.name ?? "MalSUB";
  const description = site?.description ?? "";
  const image = site?.image ?? "/og.jpg";
  const origin = host?.startsWith("http") ? host : `https://${host || "localhost"}`;
  const tags = `
<meta property="og:title" content="${name}" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="${origin}${image}" />
<meta name="twitter:card" content="summary_large_image" />
`;
  let buffer = "";
  let done = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    push(chunk) {
      if (done) return [chunk];
      buffer += decoder.decode(chunk, { stream: true });
      const idx = buffer.toLowerCase().indexOf("</head>");
      if (idx === -1) {
        if (buffer.length > 200_000) {
          done = true;
          const out = encoder.encode(buffer);
          buffer = "";
          return [out];
        }
        return [];
      }
      done = true;
      const injected = buffer.slice(0, idx) + tags + buffer.slice(idx);
      buffer = "";
      return [encoder.encode(injected)];
    },
    flush() {
      if (!buffer) return [];
      const out = encoder.encode(buffer);
      buffer = "";
      return [out];
    },
  };
}
