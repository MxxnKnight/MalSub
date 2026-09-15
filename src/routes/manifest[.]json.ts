import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders } from "@/lib/subtitle-file";
import { addonManifest } from "@/lib/stremio";

export const Route = createFileRoute("/manifest.json")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        return Response.json(addonManifest(origin), { headers: corsHeaders() });
      },
    },
  },
});
