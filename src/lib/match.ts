import type { SearchHit, TitleKind } from "@/lib/search";

export function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u0d00-\u0d7f]+/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|season|series)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleAliases(title: string) {
  const aliases = [title];
  for (const match of title.matchAll(/\(([^)]+)\)/g)) {
    if (match[1]) aliases.push(match[1]);
  }
  return aliases.map(normalizeTitle).filter(Boolean);
}

function hasWord(name: string, word: string) {
  return new RegExp(`(?:^| )${word}(?: |$)`).test(name);
}

export function scoreHit(
  hit: SearchHit,
  query: string,
  opts?: { year?: number | null; season?: number | null; kind?: TitleKind },
) {
  const names = titleAliases(`${hit.title} ${hit.seriesTitle ?? ""}`);
  const q = normalizeTitle(query);
  if (!q) return 0;
  let score = 0;
  if (names.some((name) => name === q)) score += 12;
  else if (names.some((name) => name.startsWith(`${q} `) || name.endsWith(` ${q}`)))
    score += 9;
  else if (names.some((name) => hasWord(name, q))) score += 6;
  const tokens = q.split(" ").filter((token) => token.length > 1);
  if (
    tokens.length > 1 &&
    tokens.every((token) => names.some((name) => hasWord(name, token)))
  ) {
    score += 3;
  }
  if (score === 0) return 0;
  if (opts?.year && hit.year === opts.year) score += 8;
  else if (opts?.year && hit.year && Math.abs(hit.year - opts.year) <= 1) score += 3;
  if (opts?.season && hit.season === opts.season) score += 8;
  if (opts?.kind && hit.kind === opts.kind) score += 2;
  return score;
}
