// Times as people read them.

/** Seconds as `m:ss.s`, the way the timeline shows instants. */
export function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Whole seconds as `m:ss` or `h:mm:ss`, for spoken lengths and targets. */
export function talkClock(seconds: number): string {
  const total = Math.floor(seconds + 0.5);
  const two = (value: number) => String(value).padStart(2, "0");
  if (total >= 3600) {
    return `${Math.floor(total / 3600)}:${two(Math.floor((total % 3600) / 60))}:${two(total % 60)}`;
  }
  return `${Math.floor(total / 60)}:${two(total % 60)}`;
}

/** `0:01.0–0:02.5`, or one instant when both ends meet. */
export function span(from: number, to: number): string {
  return Math.abs(to - from) < 1e-6 ? clock(from) : `${clock(from)}–${clock(to)}`;
}

/** Seconds as the CLI takes them: `1.25`, `3`. */
export function secondsArg(seconds: number): string {
  return seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** `20m`, `1h30m`, `90s` or plain seconds, as `--duration` takes them; null when unreadable. */
export function parseDuration(text: string): number | null {
  const value = text.trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!match || value === "") {
    return null;
  }
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}
