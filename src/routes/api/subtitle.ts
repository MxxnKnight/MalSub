import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders, findSubtitleFile } from "@/lib/subtitle-file";

export const Route = createFileRoute("/api/subtitle")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const page = url.searchParams.get("u") ?? "";
        if (!/^https:\/\/(malayalamsubtitles\.(org|in)|moviemirrorsubtitles\.com)\//i.test(page)) {
          return new Response("Bad request", { status: 400, headers: corsHeaders() });
        }
        const file = await findSubtitleFile(page);
        if (!file) {
          return new Response("Subtitle file not found on source page", {
            status: 404,
            headers: corsHeaders(),
          });
        }
        return new Response(null, {
          status: 302,
          headers: {
            ...corsHeaders(),
            location: file,
          },
        });
      },
    },
  },
});
