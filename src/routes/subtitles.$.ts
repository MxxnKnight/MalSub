import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders } from "@/lib/subtitle-file";
import { subtitlesForRequest } from "@/lib/stremio";

export const Route = createFileRoute("/subtitles/$")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const payload = await subtitlesForRequest(url.origin, url.pathname);
        return Response.json(payload, { headers: corsHeaders() });
      },
    },
  },
});
