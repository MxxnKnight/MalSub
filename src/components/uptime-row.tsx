import { useMemo, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import {
  buildHistory,
  HISTORY_DAYS,
  uptimePercent,
  type DayLevel,
  type LiveLevel,
} from "@/lib/status";

const LEVEL_LABEL: Record<DayLevel, string> = {
  up: "Operational",
  degraded: "Degraded",
  down: "Outage",
};

const LEVEL_COLOR: Record<DayLevel, string> = {
  up: "var(--color-up)",
  degraded: "var(--color-degraded)",
  down: "var(--color-down)",
};

function formatDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function UptimeRow({
  id,
  name,
  href,
  live,
  latencyMs,
  delay = 0,
}: {
  id: string;
  name: string;
  href?: string;
  live: LiveLevel;
  latencyMs?: number | null;
  delay?: number;
}) {
  const history = useMemo(() => buildHistory(id), [id]);
  const pct = uptimePercent(history);
  const [tip, setTip] = useState<{
    date: string;
    level: DayLevel;
    index: number;
  } | null>(null);

  const liveLabel =
    live === "checking"
      ? "Checking"
      : live === "up"
        ? "Operational"
        : live === "degraded"
          ? "Degraded"
          : "Down";

  function updateTip(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = Math.min(
      history.length - 1,
      Math.max(0, Math.floor((x / rect.width) * history.length)),
    );
    const point = history[index];
    if (!point) return;
    setTip({ date: point.date, level: point.level, index });
  }

  return (
    <article
      className="rise rounded-[var(--radius-lg)] bg-surface p-4 shadow-[var(--shadow-border)] sm:p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                live === "checking" && "bg-muted pulse-live",
                live === "up" && "bg-up pulse-live",
                live === "degraded" && "bg-degraded",
                live === "down" && "bg-down",
              )}
              aria-hidden="true"
            />
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="truncate text-sm font-medium text-fg transition-colors duration-[var(--motion-quick)] hover:text-accent"
              >
                {name}
              </a>
            ) : (
              <h3 className="truncate text-sm font-medium text-fg">{name}</h3>
            )}
          </div>
          <p className="mt-1 pl-4 text-xs text-subtle">
            {liveLabel}
            {typeof latencyMs === "number" && live !== "checking"
              ? ` · ${latencyMs} ms`
              : null}
          </p>
        </div>
        <p className="shrink-0 font-mono text-sm tabular-nums text-muted">
          {pct.toFixed(1)}
          <span className="ml-1 text-xs text-subtle">%</span>
        </p>
      </div>

      <div className="relative mt-4">
        <div
          className="flex h-6 cursor-crosshair items-stretch gap-px sm:h-7 sm:gap-0.5"
          role="img"
          aria-label={`${name} ${HISTORY_DAYS}-day uptime ${pct.toFixed(1)} percent`}
          onPointerMove={updateTip}
          onPointerLeave={() => setTip(null)}
        >
          {history.map((point, index) => (
            <span
              key={point.date}
              className={cn(
                "min-w-0 flex-1 rounded-sm transition-[filter,transform] duration-[var(--motion-micro)] ease-[var(--ease-out)]",
                tip?.index === index && "z-10 scale-y-125",
              )}
              style={{
                background: LEVEL_COLOR[point.level],
                opacity: tip && tip.index !== index ? 0.45 : 1,
              }}
            />
          ))}
        </div>
        {tip ? (
          <div
            className="pointer-events-none absolute -top-8 z-10 whitespace-nowrap rounded-[var(--radius-sm)] bg-fg px-2 py-1 text-xs text-bg shadow-[var(--shadow-border)]"
            style={{
              left: `clamp(0.75rem, ${((tip.index + 0.5) / history.length) * 100}%, calc(100% - 0.75rem))`,
              transform: "translateX(-50%)",
            }}
          >
            {formatDay(tip.date)} · {LEVEL_LABEL[tip.level]}
          </div>
        ) : null}
        <div className="mt-2 flex justify-between text-xs text-subtle">
          <span>{HISTORY_DAYS} days ago</span>
          <span>Today</span>
        </div>
      </div>
    </article>
  );
}
