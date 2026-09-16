import { useEffect, useState } from "react";
import { Database, LoaderCircle, RefreshCw, Library } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  catalogStats,
  fetchCatalogs,
  type CatalogFetchMode,
  type CatalogStats,
  type FetchReport,
} from "@/lib/catalog";
import { cn } from "@/lib/utils";

function formatWhen(iso: string | null) {
  if (!iso) return "Never fetched";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never fetched";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AdminFetch({ compact = false }: { compact?: boolean }) {
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [reports, setReports] = useState<FetchReport[] | null>(null);
  const [busy, setBusy] = useState<CatalogFetchMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadStats() {
    try {
      setStats(await catalogStats());
    } catch {
      setError("Could not read catalog stats.");
    }
  }

  useEffect(() => {
    void loadStats();
  }, []);

  async function runFetch(mode: CatalogFetchMode) {
    if (busy) return;
    setBusy(mode);
    setError(null);
    try {
      const result = await fetchCatalogs({ data: { mode } });
      setReports(result.sources);
      await loadStats();
      window.dispatchEvent(new Event("malsub:catalog"));
    } catch {
      setError("Fetch failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      id="admin"
      className={cn(
        "rounded-[var(--radius-xl)] bg-surface shadow-[var(--shadow-border)]",
        compact ? "p-4" : "p-5 sm:p-6",
      )}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-accent uppercase">
            <Database className="size-3.5" />
            Admin
          </p>
          <h2 className="mt-1 font-display text-lg font-semibold tracking-tight sm:text-xl">
            Catalog fetch
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Builds the title index for MSone, Movie Mirror, and Team GOAT.
            Search and the Stremio addon only use what is stored here.
          </p>
          <p className="mt-2 font-mono text-xs tabular-nums text-subtle">
            {stats
              ? `${stats.total.toLocaleString("en-IN")} titles · ${stats.engine === "mongodb" ? "MongoDB MALsub" : "local preview DB"} · ${formatWhen(stats.lastFetchedAt)}`
              : "Loading catalog…"}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row lg:flex-col">
          <Button
            type="button"
            onClick={() => void runFetch("full")}
            disabled={Boolean(busy)}
            className="w-full shrink-0 sm:w-auto"
          >
            {busy === "full" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Library />
            )}
            {busy === "full" ? "Full fetch…" : "Full index"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void runFetch("incremental")}
            disabled={Boolean(busy)}
            className="w-full shrink-0 sm:w-auto"
          >
            {busy === "incremental" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {busy === "incremental" ? "Fetching…" : "New releases only"}
          </Button>
        </div>
      </div>

      <p className="mt-3 text-xs text-subtle">
        <span className="font-medium text-muted">Full index</span> — deep scrape
        (sitemaps + many pages). Use once to fill ~thousands of titles, or when
        the catalog looks incomplete.{" "}
        <span className="font-medium text-muted">New releases only</span> — RSS +
        recent pages; fast daily top-up. Auto/GitHub daily uses the same rules
        for all three sources.
      </p>

      {error ? <p className="mt-3 text-sm text-down">{error}</p> : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {(reports ?? stats?.sources ?? []).map((row) => {
          const ok = "ok" in row ? row.ok : row.lastOk;
          const inserted = "inserted" in row ? row.inserted : 0;
          const updated = "updated" in row ? row.updated : 0;
          const extra =
            reports && "ms" in row
              ? `${row.count.toLocaleString("en-IN")} read · ${inserted} new · ${updated} refreshed · ${row.ms} ms`
              : `${row.count.toLocaleString("en-IN")} stored`;
          return (
            <div
              key={row.id}
              className="rounded-[var(--radius-md)] bg-elevated px-3 py-3 shadow-[var(--shadow-border)]"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    ok === false ? "bg-down" : ok ? "bg-up" : "bg-muted",
                  )}
                />
                <p className="text-sm font-medium">{row.name}</p>
              </div>
              <p className="mt-1 font-mono text-xs tabular-nums text-subtle">
                {extra}
              </p>
              {row.note ? (
                <p className="mt-1 text-xs text-subtle">{row.note}</p>
              ) : null}
              <a
                href={row.indexUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block break-all text-xs text-accent hover:underline"
              >
                {row.indexUrl.replace(/^https:\/\//, "")}
              </a>
            </div>
          );
        })}
      </div>
    </section>
  );
}
