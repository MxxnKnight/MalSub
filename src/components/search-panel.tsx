import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Clapperboard, LoaderCircle, Search, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import { catalogStats, type CatalogStats } from "@/lib/catalog";
import { searchCatalog, type SearchHit, type SourceSearchResult, type TitleKind } from "@/lib/search";
import type { CinemetaTitle } from "@/lib/cinemeta";
import { cn } from "@/lib/utils";

const EXAMPLES = ["Heat", "Inception", "Dune", "Rambo", "The Expanse", "Parasite"] as const;

type KindFilter = "all" | TitleKind;

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState("");
  const [sources, setSources] = useState<SourceSearchResult[] | null>(null);
  const [resolved, setResolved] = useState<CinemetaTitle | null>(null);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [catalogEmpty, setCatalogEmpty] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await catalogStats();
        setStats(data);
        setCatalogEmpty(data.total === 0);
      } catch {
        // keep last stats
      }
    }
    void load();
    window.addEventListener("malsub:catalog", load);
    return () => window.removeEventListener("malsub:catalog", load);
  }, []);

  async function runSearch(raw: string) {
    const next = raw.trim();
    if (next.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    setActiveQuery(next);
    try {
      const data = await searchCatalog({ data: { query: next } });
      setSources(data.sources);
      setResolved(data.resolved ?? null);
      setCatalogEmpty(Boolean(data.catalogEmpty));
    } catch {
      setSources(null);
      setResolved(null);
      setError("Search failed. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    if (!sources) return null;
    if (kind === "all") return sources;
    return sources.map((source) => ({
      ...source,
      results: source.results.filter((hit) => hit.kind === kind),
      total: source.results.filter((hit) => hit.kind === kind).length,
    }));
  }, [sources, kind]);

  const anyHits = filtered?.some((s) => s.results.length > 0) ?? false;

  return (
    <section id="search" className="cv-auto mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <div className="mb-6">
        <p className="text-xs font-medium tracking-wide text-accent uppercase">
          Database search
        </p>
        <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
          Search stored catalogs
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          Results use Cinemeta to resolve the title, then match stored subtitle
          pages from MSone, Movie Mirror, and Team GOAT.
        </p>
        <p className="mt-2 font-mono text-xs tabular-nums text-subtle">
          {stats
            ? `${stats.total.toLocaleString("en-IN")} titles stored`
            : "Reading catalog…"}
        </p>
      </div>

      <form
        className="rounded-[var(--radius-xl)] bg-surface p-2 shadow-[var(--shadow-border)] sm:p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query);
        }}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative min-h-12 flex-1">
            <span className="sr-only">Search titles</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search movies or series"
              autoComplete="off"
              spellCheck={false}
              className="h-12 w-full rounded-[var(--radius-md)] bg-elevated pr-3 pl-10 text-base text-fg shadow-[var(--shadow-border)] outline-none placeholder:text-subtle focus-visible:ring-2 focus-visible:ring-accent/70 sm:text-sm"
            />
          </label>
          <Button type="submit" size="lg" disabled={busy || query.trim().length < 2} className="w-full sm:w-auto sm:min-w-32">
            {busy ? <LoaderCircle className="animate-spin" /> : <Search />}
            {busy ? "Searching" : "Search"}
          </Button>
        </div>
      </form>

      {catalogEmpty ? (
        <p className="mt-3 text-sm text-muted">
          Catalog is empty.{" "}
          <Link to="/admin" className="text-accent underline-offset-2 hover:underline">
            Open Admin and fetch
          </Link>{" "}
          the three sources first.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setQuery(example);
              void runSearch(example);
            }}
            className="h-11 rounded-full bg-surface px-3 text-xs font-medium text-muted shadow-[var(--shadow-border)] transition-[color,background-color,box-shadow] duration-[var(--motion-quick)] hover:text-fg hover:shadow-[var(--shadow-border-hover)] sm:h-9"
          >
            {example}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(["all", "movie", "series"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setKind(value)}
            className={cn(
              "h-11 rounded-full px-3 text-xs font-medium shadow-[var(--shadow-border)] transition-[color,background-color] duration-[var(--motion-quick)] sm:h-9",
              kind === value ? "bg-fg text-bg" : "bg-surface text-muted hover:text-fg",
            )}
          >
            {value === "all" ? "All" : value === "movie" ? "Movies" : "Series"}
          </button>
        ))}
      </div>

      {error ? (
        <p className="mt-6 text-sm text-down">{error}</p>
      ) : null}

      {busy && !sources ? <SearchSkeleton /> : null}

      {filtered ? (
        <div className={cn("mt-8", busy && "pointer-events-none opacity-60")}>
          <p className="mb-4 text-sm text-muted">
            Database results for <span className="text-fg">{activeQuery}</span>
            {resolved ? (
              <>
                {" "}
                · Cinemeta{" "}
                <span className="text-fg">
                  {resolved.name}
                  {resolved.year ? ` (${resolved.year})` : ""}
                </span>
              </>
            ) : null}
            {anyHits ? null : " — no matching tracks"}
          </p>
          <div className="grid gap-3 lg:grid-cols-3">
            {filtered.map((source) => (
              <SourceColumn key={source.id} source={source} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SourceColumn({ source }: { source: SourceSearchResult }) {
  return (
    <section className="rounded-[var(--radius-xl)] bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                source.ok ? "bg-up" : "bg-down",
              )}
            />
            <h3 className="truncate text-sm font-medium">{source.name}</h3>
          </div>
          <p className="mt-1 font-mono text-xs tabular-nums text-subtle">
            {source.ok ? `${source.total} hit${source.total === 1 ? "" : "s"} · ${source.ms} ms` : "No catalog yet"}
          </p>
        </div>
        <a
          href={source.searchUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-subtle transition-colors duration-[var(--motion-quick)] hover:text-fg sm:size-9"
          aria-label={`Open ${source.name}`}
        >
          <ArrowUpRight className="size-4" />
        </a>
      </div>
      {source.note ? (
        <p className="mt-3 text-xs text-subtle">{source.note}</p>
      ) : null}
      <ul className="mt-4 grid gap-2">
        {source.results.length === 0 ? (
          <li className="rounded-[var(--radius-md)] bg-elevated px-3 py-4 text-sm text-subtle">
            No matching title
          </li>
        ) : (
          source.results.map((hit) => <ResultRow key={hit.url} hit={hit} />)
        )}
      </ul>
    </section>
  );
}

function ResultRow({ hit }: { hit: SearchHit }) {
  const KindIcon = hit.kind === "series" ? Tv : Clapperboard;
  return (
    <li>
      <a
        href={hit.url}
        target="_blank"
        rel="noreferrer"
        className="group flex min-h-11 gap-3 rounded-[var(--radius-md)] bg-elevated p-2 shadow-[var(--shadow-border)] transition-[box-shadow] duration-[var(--motion-quick)] hover:shadow-[var(--shadow-border-hover)]"
      >
        <Poster hit={hit} />
        <span className="min-w-0 flex-1 py-0.5">
          <span className="block truncate text-sm font-medium text-fg">
            {hit.title}
          </span>
          <span className="mt-1 flex items-center gap-2 text-xs text-subtle">
            <KindIcon className="size-3.5 shrink-0" />
            {hit.kind === "series" ? "Series" : "Movie"}
            {hit.kind === "series" && hit.season ? (
              <span className="tabular-nums">S{hit.season}</span>
            ) : null}
            {hit.year ? <span className="tabular-nums">{hit.year}</span> : null}
          </span>
        </span>
      </a>
    </li>
  );
}

function Poster({ hit }: { hit: SearchHit }) {
  const [failed, setFailed] = useState(false);
  if (!hit.poster || failed) {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface font-display text-xs font-semibold text-accent">
        {hit.title.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={hit.poster}
      alt=""
      width={48}
      height={48}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-12 max-w-full shrink-0 rounded-[var(--radius-sm)] object-cover outline outline-1 -outline-offset-1 outline-white/10"
    />
  );
}

function SearchSkeleton() {
  return (
    <div className="mt-8 grid gap-3 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={i}
          className="h-56 animate-pulse rounded-[var(--radius-xl)] bg-surface shadow-[var(--shadow-border)]"
        />
      ))}
    </div>
  );
}
