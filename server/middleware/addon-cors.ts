import { corsHeaders } from "../../src/lib/subtitle-file";

function isAddonPath(path: string) {
  return (
    path === "/manifest.json" ||
    path.startsWith("/subtitles/") ||
    path.startsWith("/api/subtitle")
  );
}

export default async function addonCorsMiddleware(
  event: { url: URL; req: { method: string } },
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const path = event.url.pathname;
  const method = (event.req.method ?? "GET").toUpperCase();
  if (!isAddonPath(path)) return next();
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  const result = await next();
  if (!(result instanceof Response)) return result;
  const headers = new Headers(result.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}
