import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="16" fill="var(--color-surface)" />
      <rect
        x="0.75"
        y="0.75"
        width="62.5"
        height="62.5"
        rx="15.25"
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth="1.5"
      />
      <rect x="12" y="18" width="40" height="7" rx="3.5" fill="var(--color-fg)" />
      <rect
        x="12"
        y="29"
        width="28"
        height="7"
        rx="3.5"
        fill="var(--color-accent)"
      />
      <rect
        x="12"
        y="40"
        width="34"
        height="7"
        rx="3.5"
        fill="var(--color-fg)"
        opacity="0.38"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display font-semibold tracking-tight", className)}>
      MalSUB
    </span>
  );
}
