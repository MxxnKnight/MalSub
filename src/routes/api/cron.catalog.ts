import { createFileRoute } from "@tanstack/react-router";
import type { CatalogFetchMode } from "@/lib/catalog";

function authorized(request: Request) {
  const secret =
    (typeof process !== "undefined" && process.env.CATALOG_FETCH_SECRET) || "";
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const query = new URL(request.url).searchParams.get("secret") ?? "";
  return bearer === secret || query === secret;
}

export const Route = createFileRoute("/api/cron/catalog")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorized(request)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        const url = new URL(request.url);
        const modeParam = (url.searchParams.get("mode") ?? "auto") as CatalogFetchMode;
        const mode: CatalogFetchMode =
          modeParam === "full" || modeParam === "incremental" || modeParam === "auto"
            ? modeParam
            : "auto";

        const { runCatalogFetch } = await import("@/lib/catalog");
        const report = await runCatalogFetch(mode);
        return new Response(JSON.stringify(report, null, 2), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      POST: async ({ request }) => {
        if (!authorized(request)) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        let mode: CatalogFetchMode = "auto";
        try {
          const body = (await request.json()) as { mode?: string };
          if (
            body?.mode === "full" ||
            body?.mode === "incremental" ||
            body?.mode === "auto"
          ) {
            mode = body.mode;
          }
        } catch {
          // empty body is fine
        }
        const url = new URL(request.url);
        const q = url.searchParams.get("mode");
        if (q === "full" || q === "incremental" || q === "auto") mode = q;

        const { runCatalogFetch } = await import("@/lib/catalog");
        const report = await runCatalogFetch(mode);
        return new Response(JSON.stringify(report, null, 2), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
