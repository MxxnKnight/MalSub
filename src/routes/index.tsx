import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Film,
  Languages,
  Puzzle,
  Subtitles,
} from "lucide-react";
import { ADDON, SOURCES, manifestUrl, stremioInstallUrl } from "@/lib/addon";
import { checkSources, type LiveLevel } from "@/lib/status";
import { LogoMark, Wordmark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { SearchPanel } from "@/components/search-panel";
import { AdminFetch } from "@/components/admin-fetch";
import { UptimeRow } from "@/components/uptime-row";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

type LiveMap = Record<string, { level: LiveLevel; ms: number | null }>;

function Home() {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [live, setLive] = useState<LiveMap>(() => ({
    addon: { level: "checking", ms: null },
    msone: { level: "checking", ms: null },
    "movie-mirror": { level: "checking", ms: null },
    "team-goat": { level: "checking", ms: null },
  }));

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const addonStart = Date.now();
      const addonPromise = fetch("/manifest.json", { method: "GET" })
        .then((res) => ({
          ok: res.ok,
          ms: Date.now() - addonStart,
        }))
        .catch(() => ({ ok: false, ms: Date.now() - addonStart }));

      const sourcesPromise = checkSources();

      const [addon, sources] = await Promise.all([addonPromise, sourcesPromise]);
      if (cancelled) return;

      const next: LiveMap = {
        addon: { level: addon.ok ? "up" : "down", ms: addon.ms },
      };
      for (const row of sources.sources) {
        next[row.id] = { level: row.ok ? "up" : "down", ms: row.ms };
      }
      setLive((prev) => ({ ...prev, ...next }));
    }

    void refresh();
    const id = window.setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const manifest = origin ? manifestUrl(origin) : "/manifest.json";
  const installHref = origin ? stremioInstallUrl(origin) : "#";

  const overall = useMemo(() => {
    const levels = Object.values(live).map((v) => v.level);
    if (levels.some((l) => l === "checking")) return "checking" as const;
    if (levels.every((l) => l === "up")) return "up" as const;
    if (levels.some((l) => l === "down")) return "down" as const;
    return "degraded" as const;
  }, [live]);

  async function copyManifest() {
    try {
      await navigator.clipboard.writeText(manifest);
    } catch {
      const el = document.createElement("textarea");
      el.value = manifest;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="hero-wash relative min-h-dvh overflow-x-hidden">
      <SiteHeader onCopy={copyManifest} copied={copied} />
      <main>
        <Hero
          manifest={manifest}
          installHref={installHref}
          copied={copied}
          onCopy={copyManifest}
          overall={overall}
        />
        <SearchPanel />
        <section className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
          <AdminFetch compact />
        </section>
        <StatusSection live={live} overall={overall} />
        <SourcesSection />
        <HowItWorks />
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader({
  onCopy,
  copied,
}: {
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg/90">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
        <a href="#top" className="flex min-w-0 items-center gap-2.5">
          <LogoMark className="size-8" />
          <Wordmark className="text-sm" />
        </a>
        <nav className="hidden items-center gap-5 text-sm text-muted md:flex">
          <a href="#search" className="transition-colors hover:text-fg">
            Search
          </a>
          <a href="#admin" className="transition-colors hover:text-fg">
            Admin
          </a>
          <a href="#status" className="transition-colors hover:text-fg">
            Status
          </a>
          <a href="#sources" className="transition-colors hover:text-fg">
            Sources
          </a>
          <a href="#install" className="transition-colors hover:text-fg">
            Install
          </a>
        </nav>
        <Button size="sm" onClick={onCopy} className="shrink-0 pl-3.5 pr-3">
          <span className="relative size-4">
            <Check
              className={cn(
                "absolute inset-0 transition-[opacity,transform,filter] duration-[var(--motion-fast)]",
                copied
                  ? "scale-100 opacity-100 blur-0"
                  : "scale-[0.25] opacity-0 blur-[4px]",
              )}
            />
            <Copy
              className={cn(
                "absolute inset-0 transition-[opacity,transform,filter] duration-[var(--motion-fast)]",
                copied
                  ? "scale-[0.25] opacity-0 blur-[4px]"
                  : "scale-100 opacity-100 blur-0",
              )}
            />
          </span>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <nav className="flex gap-4 overflow-x-auto px-4 py-2 text-xs text-muted md:hidden">
        <a href="#search" className="shrink-0 py-2">
          Search
        </a>
        <a href="#admin" className="shrink-0 py-2">
          Admin
        </a>
        <a href="#status" className="shrink-0 py-2">
          Status
        </a>
        <a href="#sources" className="shrink-0 py-2">
          Sources
        </a>
        <a href="#install" className="shrink-0 py-2">
          Install
        </a>
      </nav>
    </header>
  );
}

function Hero({
  manifest,
  installHref,
  copied,
  onCopy,
  overall,
}: {
  manifest: string;
  installHref: string;
  copied: boolean;
  onCopy: () => void;
  overall: LiveLevel;
}) {
  return (
    <section
      id="top"
      className="mx-auto flex max-w-5xl flex-col items-center px-4 pt-8 pb-8 text-center sm:px-6 sm:pt-20 sm:pb-14"
    >
      <div className="rise" style={{ animationDelay: "0ms" }}>
        <LogoMark className="size-14 sm:size-20" />
      </div>
      <p
        className="rise mt-6 font-ml text-lg text-accent sm:text-xl"
        style={{ animationDelay: "60ms" }}
      >
        മലയാളം സബ്‌ടൈറ്റിലുകൾ
      </p>
      <h1
        className="rise mt-2 font-display text-3xl font-semibold tracking-tight text-fg sm:text-6xl"
        style={{ animationDelay: "100ms" }}
      >
        MalSUB
      </h1>
      <p
        className="rise mt-4 max-w-xl text-sm leading-relaxed text-muted sm:text-lg"
        style={{ animationDelay: "160ms" }}
      >
        {ADDON.description}
      </p>
      <div
        className="rise mt-5 flex flex-wrap items-center justify-center gap-2"
        style={{ animationDelay: "200ms" }}
      >
        <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted shadow-[var(--shadow-border)]">
          Stremio
        </span>
        <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted shadow-[var(--shadow-border)]">
          Nuvio
        </span>
        <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted shadow-[var(--shadow-border)]">
          v{ADDON.version}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-xs font-medium shadow-[var(--shadow-border)]",
            overall === "up" && "text-up",
            overall === "down" && "text-down",
            overall === "degraded" && "text-degraded",
            overall === "checking" && "text-muted",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              overall === "up" && "bg-up pulse-live",
              overall === "down" && "bg-down",
              overall === "degraded" && "bg-degraded",
              overall === "checking" && "bg-muted",
            )}
          />
          {overall === "checking"
            ? "Checking sources"
            : overall === "up"
              ? "All sources up"
              : overall === "down"
                ? "Source issue"
                : "Degraded"}
        </span>
      </div>
      <div
        id="install"
        className="rise mt-8 flex w-full max-w-md flex-col gap-3 sm:max-w-none sm:flex-row sm:justify-center"
        style={{ animationDelay: "260ms" }}
      >
        <Button asChild size="lg" className="w-full sm:w-auto sm:min-w-48">
          <a href={installHref}>
            <Puzzle />
            Install addon
          </a>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onCopy}
          className="w-full sm:w-auto sm:min-w-48"
        >
          <span className="relative size-4">
            <Check
              className={cn(
                "absolute inset-0 transition-[opacity,transform,filter] duration-[var(--motion-fast)]",
                copied
                  ? "scale-100 opacity-100 blur-0"
                  : "scale-[0.25] opacity-0 blur-[4px]",
              )}
            />
            <Copy
              className={cn(
                "absolute inset-0 transition-[opacity,transform,filter] duration-[var(--motion-fast)]",
                copied
                  ? "scale-[0.25] opacity-0 blur-[4px]"
                  : "scale-100 opacity-100 blur-0",
              )}
            />
          </span>
          {copied ? "Copied manifest" : "Copy manifest link"}
        </Button>
      </div>
      <p
        className="rise mt-4 max-w-lg text-xs leading-relaxed text-subtle"
        style={{ animationDelay: "320ms" }}
      >
        Stremio opens the install prompt. For Nuvio, copy the manifest and paste
        it under Addons → Install from URL.
      </p>
      <button
        type="button"
        onClick={onCopy}
        className="rise mt-5 w-full max-w-lg break-all rounded-[var(--radius-md)] bg-elevated px-3 py-2 font-mono text-xs text-muted shadow-[var(--shadow-border)] transition-colors hover:text-fg"
        style={{ animationDelay: "360ms" }}
        title="Copy manifest URL"
      >
        {manifest}
      </button>
    </section>
  );
}

function StatusSection({
  live,
  overall,
}: {
  live: LiveMap;
  overall: LiveLevel;
}) {
  return (
    <section id="status" className="cv-auto mx-auto max-w-5xl px-4 pb-20 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-wide text-accent uppercase">
            Uptime
          </p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Addon and source health
          </h2>
        </div>
        <p className="text-sm text-muted">
          {overall === "up"
            ? "All systems operational"
            : overall === "checking"
              ? "Refreshing live checks"
              : "One or more sources need attention"}
        </p>
      </div>
      <div className="mb-4 flex flex-wrap gap-3 text-xs text-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-1.5 rounded-sm bg-up" />
          Operational
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-1.5 rounded-sm bg-degraded" />
          Degraded
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-1.5 rounded-sm bg-down" />
          Outage
        </span>
      </div>
      <div className="grid gap-3">
        <UptimeRow
          id="addon"
          name="MalSUB addon"
          live={live.addon?.level ?? "checking"}
          latencyMs={live.addon?.ms}
          delay={0}
        />
        {SOURCES.map((source, i) => (
          <UptimeRow
            key={source.id}
            id={source.id}
            name={`${source.name} fetch`}
            href={source.url}
            live={live[source.id]?.level ?? "checking"}
            latencyMs={live[source.id]?.ms}
            delay={80 + i * 80}
          />
        ))}
      </div>
      <p className="mt-4 text-xs text-subtle">
        Live dots ping the addon manifest and the three subtitle sites. Each
        tick is one day over the last 90.
      </p>
    </section>
  );
}

function SourcesSection() {
  return (
    <section id="sources" className="cv-auto mx-auto max-w-5xl px-4 pb-20 sm:px-6">
      <p className="text-xs font-medium tracking-wide text-accent uppercase">
        Sources
      </p>
      <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
        Three Malayalam fansub groups
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        MalSUB does not write subtitles. It finds and attaches tracks published
        by these groups so they show up as Malayalam options in Stremio and
        Nuvio.
      </p>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {SOURCES.map((source, i) => (
          <a
            key={source.id}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="rise group flex flex-col rounded-[var(--radius-xl)] bg-surface p-5 shadow-[var(--shadow-border)] transition-[box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--ease-out)] hover:shadow-[var(--shadow-border-hover)]"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-elevated font-display text-sm font-semibold text-accent shadow-[var(--shadow-border)]">
                {source.short}
              </span>
              <ArrowUpRight className="size-4 text-subtle transition-transform duration-[var(--motion-fast)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg" />
            </div>
            <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">
              {source.name}
            </h3>
            <p className="mt-1 text-xs text-subtle">Est. {source.since}</p>
            <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">
              {source.blurb}
            </p>
          </a>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: Download,
      title: "Install MalSUB",
      body: "Use the install button in Stremio, or paste the manifest URL into Nuvio addons.",
    },
    {
      icon: Film,
      title: "Play a title",
      body: "Open any movie or episode. MalSUB matches it and queries the three subtitle sites.",
    },
    {
      icon: Languages,
      title: "Pick Malayalam",
      body: "Choose a track from MSone, Movie Mirror, or Team GOAT in the player subtitle menu.",
    },
  ];

  return (
    <section className="cv-auto mx-auto max-w-5xl px-4 pb-24 sm:px-6">
      <p className="text-xs font-medium tracking-wide text-accent uppercase">
        How it works
      </p>
      <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
        Subtitles, without leaving the player
      </h2>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {steps.map((step, i) => (
          <div
            key={step.title}
            className="rise rounded-[var(--radius-xl)] bg-surface p-5 shadow-[var(--shadow-border)]"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="flex size-10 items-center justify-center rounded-[var(--radius-md)] bg-elevated text-accent shadow-[var(--shadow-border)]">
              <step.icon className="size-4" />
            </div>
            <p className="mt-4 font-mono text-[11px] tracking-wide text-subtle uppercase">
              Step {i + 1}
            </p>
            <h3 className="mt-1 font-display text-lg font-semibold tracking-tight">
              {step.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <LogoMark className="size-7 shrink-0" />
          <div className="min-w-0">
            <Wordmark className="text-sm" />
            <p className="text-xs text-subtle">
              Community addon · not affiliated with the fansub groups
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <Link
            to="/admin"
            className="text-xs text-muted transition-colors duration-[var(--motion-quick)] hover:text-fg"
          >
            Admin
          </Link>
          <p className="flex items-center gap-1.5 text-xs text-subtle">
            <Subtitles className="size-3.5 shrink-0" />
            Subtitles remain the work of MSone, Movie Mirror, and Team GOAT.
          </p>
        </div>
      </div>
    </footer>
  );
}
