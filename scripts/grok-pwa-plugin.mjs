/** Dev/build plugin stub — production PWA chrome lives in server/middleware/grok-pwa.ts. */
export function grokPwaPlugin() {
  return {
    name: "app-builder:grok-pwa",
    config() {
      return {};
    },
    // Provide virtual module expected by server middleware at build time
    resolveId(id) {
      if (id === "virtual:grok-og-identity") return id;
    },
    load(id) {
      if (id === "virtual:grok-og-identity") {
        return `export const grokOgIdentity = ${JSON.stringify({
          site: {
            name: "MalSUB",
            description: "Malayalam subtitles for Stremio and Nuvio",
            image: "/og.jpg",
          },
        })};`;
      }
    },
  };
}
