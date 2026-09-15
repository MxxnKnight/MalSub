import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { LogoMark, Wordmark } from "@/components/logo";
import { AdminFetch } from "@/components/admin-fetch";

export const Route = createFileRoute("/admin")({ component: AdminPage });

const SEASON_EXAMPLE = `{
  "sourceId": "team-goat",
  "kind": "series",
  "seriesTitle": "House of the Dragon",
  "season": 3,
  "year": 2026,
  "title": "HOUSE OF THE DRAGON SEASON 03 – ഹൗസ് ഓഫ് ദ ഡ്രാഗൺ (2026)",
  "pageUrl": "https://malayalamsubtitles.in/release/house-of-the-dragon-season3-2026",
  "subtitleUrl": null,
  "poster": null,
  "lastmod": null,
  "fetchedAt": "2026-09-13T13:46:00.000Z",
  "createdAt": "2026-09-13T13:46:00.000Z"
}`;

function AdminPage() {
  return (
    <div className="hero-wash min-h-dvh">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <LogoMark className="size-8" />
            <Wordmark className="text-sm" />
          </Link>
          <Link
            to="/"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted transition-colors duration-[var(--motion-quick)] hover:text-fg"
          >
            <ArrowLeft className="size-4" />
            Home
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <p className="text-xs font-medium tracking-wide text-accent uppercase">
          Catalog
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight sm:text-4xl">
          Source database
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          Fetch reads each source index, upserts subtitle page URLs into the
          catalog, and skips titles that are already stored. Set{" "}
          <span className="font-mono text-fg">MONGODB_URI</span> to use the
          MALsub MongoDB database.
        </p>
        <div className="mt-8">
          <AdminFetch />
        </div>
        <section className="mt-10">
          <p className="text-xs font-medium tracking-wide text-accent uppercase">
            Season document
          </p>
          <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">
            What a series row looks like
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
            One document per season page, not per episode. The addon opens
            <span className="font-mono text-fg"> pageUrl </span>
            at play time to find the current subtitle file.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-[var(--radius-xl)] bg-elevated p-4 text-xs leading-relaxed text-muted shadow-[var(--shadow-border)]">
            {SEASON_EXAMPLE}
          </pre>
        </section>
      </main>
    </div>
  );
}
