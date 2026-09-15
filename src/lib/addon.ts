export const ADDON = {
  id: "community.malsub",
  name: "MalSUB",
  version: "1.0.0",
  tagline: "Malayalam subtitles for Stremio and Nuvio",
  description:
    "A subtitle addon that fetches Malayalam tracks from MSone, Movie Mirror, and Team GOAT — three of the most trusted fansub groups — and delivers them inside your player.",
} as const;

export const MONGO_DB_NAME = "MALsub";

export const SOURCES = [
  {
    id: "msone",
    name: "MSone",
    short: "MS",
    url: "https://malayalamsubtitles.org/",
    pingUrl: "https://malayalamsubtitles.org/",
    indexUrl: "https://malayalamsubtitles.org/sitemap_index.xml",
    indexKind: "xml" as const,
    since: "2012",
    blurb:
      "Malayalam Subtitles for Everyone. Community-made tracks for world cinema, from classics to new releases.",
  },
  {
    id: "movie-mirror",
    name: "Movie Mirror",
    short: "MM",
    url: "https://moviemirrorsubtitles.com/",
    pingUrl: "https://moviemirrorsubtitles.com/",
    indexUrl: "https://moviemirrorsubtitles.com/subtitles/",
    indexKind: "html" as const,
    since: "2020",
    blurb:
      "High-quality Malayalam subtitles across a wide range of films, with a steady release cadence.",
  },
  {
    id: "team-goat",
    name: "Team GOAT",
    short: "TG",
    url: "https://malayalamsubtitles.in/",
    pingUrl: "https://malayalamsubtitles.in/",
    indexUrl: "https://malayalamsubtitles.in/search-and-download/",
    indexKind: "html" as const,
    since: "2021",
    blurb:
      "Malayalam translations for films and series, published independently by the Team GOAT group.",
  },
] as const;

export type SourceId = (typeof SOURCES)[number]["id"];

export function manifestUrl(origin: string) {
  return `${origin.replace(/\/$/, "")}/manifest.json`;
}

export function stremioInstallUrl(origin: string) {
  return manifestUrl(origin).replace(/^https?:\/\//, "stremio://");
}
