// The timeline `gaanim inspect --json` prints, and a preview's `ready` sends.
//
// Every segment, stop, marker, voiceover and `play` comes with its times and
// the script line that made it, so the extension knows the instant each line
// of code stands for, names built at run time included.

import { clock, span } from "./clock";

export interface TimelineStop {
  name?: string | null;
  time: number;
  file?: string | null;
  line?: number | null;
}

export interface TimelineSegment {
  name: string;
  section?: string | null;
  start: number;
  end: number;
  file?: string | null;
  line?: number | null;
  stops?: TimelineStop[];
}

export interface TimelineSpan {
  start: number;
  end: number;
  file?: string | null;
  line?: number | null;
}

export interface Timeline {
  schema: number;
  script?: string;
  duration: number;
  segments: TimelineSegment[];
  sections?: { key: string; start: number; end: number }[];
  markers?: { name: string; time: number; file?: string | null; line?: number | null }[];
  voiceovers?: (TimelineSpan & { key: string })[];
  plays?: TimelineSpan[];
  live_take?: TimelineSpan | null;
}

export type PointKind = "segment" | "stop" | "marker" | "voiceover" | "play";

export interface TimelinePoint {
  kind: PointKind;
  name?: string;
  segment?: string;
  /** The instant the line stands for. */
  time: number;
  file: string;
  line: number;
}

/** A path in the form both sides compare: forward slashes, and case folded on Windows drives. */
export function pathKey(path: string): string {
  const slashes = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(slashes) || process.platform === "win32" ? slashes.toLowerCase() : slashes;
}

/** The timeline among the JSON objects `inspect` printed: the last with a `schema`. */
export function findTimeline(objects: unknown[]): Timeline | undefined {
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i] as Partial<Timeline> | null;
    if (object && typeof object === "object" && object.schema !== undefined && Array.isArray(object.segments)) {
      return object as Timeline;
    }
  }
  return undefined;
}

/**
 * Every line that stands for an instant, by the rules of the preview's
 * `follow`: a segment rests at its first stop (else its end), a stop and a
 * marker at their time, a voiceover at its start and a `play` at its end.
 */
export function points(data: Timeline): TimelinePoint[] {
  const out: TimelinePoint[] = [];
  const add = (
    kind: PointKind,
    name: string | undefined,
    segment: string | undefined,
    time: number,
    file?: string | null,
    line?: number | null,
  ) => {
    if (file && line) {
      out.push({ kind, name, segment, time, file, line });
    }
  };
  for (const segment of data.segments ?? []) {
    const rest = segment.stops?.[0]?.time ?? segment.end;
    add("segment", segment.name, segment.name, rest, segment.file, segment.line);
    for (const stop of segment.stops ?? []) {
      add("stop", stop.name ?? undefined, segment.name, stop.time, stop.file, stop.line);
    }
  }
  for (const marker of data.markers ?? []) {
    add("marker", marker.name, undefined, marker.time, marker.file, marker.line);
  }
  for (const voiceover of data.voiceovers ?? []) {
    add("voiceover", voiceover.key, undefined, voiceover.start, voiceover.file, voiceover.line);
  }
  for (const play of data.plays ?? []) {
    add("play", undefined, undefined, play.end, play.file, play.line);
  }
  return out;
}

/** The instant a line stands for: what was made on it, else on the nearest line above in the same file. */
export function pointAt(data: Timeline, file: string, line: number): TimelinePoint | undefined {
  const wanted = pathKey(file);
  let best: TimelinePoint | undefined;
  for (const point of points(data)) {
    if (point.line <= line && pathKey(point.file) === wanted) {
      if (!best || point.line > best.line || (point.line === best.line && point.time > best.time)) {
        best = point;
      }
    }
  }
  return best;
}

/** The segment shown at `time`. */
export function segmentAt(data: Timeline, time: number): TimelineSegment | undefined {
  let found: TimelineSegment | undefined;
  for (const segment of data.segments ?? []) {
    if (segment.start <= time + 1e-6) {
      found = segment;
    }
  }
  return found;
}

/** Where a segment, and optionally one of its stops, was declared. */
export function location(data: Timeline, segment?: string, stop?: string): { file: string; line: number } | undefined {
  for (const candidate of data.segments ?? []) {
    if (segment !== undefined && candidate.name !== segment) {
      continue;
    }
    if (stop !== undefined) {
      for (const s of candidate.stops ?? []) {
        if ((s.name ?? "") === stop && s.file && s.line) {
          return { file: s.file, line: s.line };
        }
      }
    } else if (candidate.file && candidate.line) {
      return { file: candidate.file, line: candidate.line };
    }
  }
  return undefined;
}

export interface Icons {
  segment: string;
  section: string;
  stop: string;
  marker: string;
  voiceover: string;
  playing: string;
  paused: string;
  loop: string;
  time: string;
}

/** Plain characters: inlay hints and hovers cannot show codicons. */
export const ICONS: Icons = {
  segment: "▤",
  section: "§",
  stop: "⏸",
  marker: "◆",
  voiceover: "♪",
  playing: "▶",
  paused: "⏸",
  loop: "⟲",
  time: "⏱",
};

function here(item: { file?: string | null; line?: number | null }, wanted: string): item is { file: string; line: number } {
  return Boolean(item.file && item.line && pathKey(item.file) === wanted);
}

/** What the timeline says happens on each line of a file: labels by 1-based line. */
export function lineLabels(data: Timeline, file: string, icons: Icons = ICONS): Map<number, string[]> {
  const wanted = pathKey(file);
  const lines = new Map<number, string[]>();
  const add = (line: number, text: string) => {
    const list = lines.get(line) ?? [];
    list.push(text);
    lines.set(line, list);
  };
  for (const segment of data.segments ?? []) {
    if (here(segment, wanted)) {
      add(segment.line, `${icons.segment} ${span(segment.start, segment.end)} · ${(segment.end - segment.start).toFixed(1)}s`);
    }
    for (const stop of segment.stops ?? []) {
      if (here(stop, wanted)) {
        add(stop.line, `${icons.stop} ${clock(stop.time)}`);
      }
    }
  }
  for (const marker of data.markers ?? []) {
    if (here(marker, wanted)) {
      add(marker.line, `${icons.marker} ${clock(marker.time)}`);
    }
  }
  for (const voiceover of data.voiceovers ?? []) {
    if (here(voiceover, wanted)) {
      add(voiceover.line, `${icons.voiceover} ${span(voiceover.start, voiceover.end)}`);
    }
  }
  // Plays: one label per line, with how many when a loop plays several.
  const plays = new Map<number, { count: number; from: number; to: number }>();
  for (const play of data.plays ?? []) {
    if (here(play, wanted)) {
      const entry = plays.get(play.line);
      if (entry) {
        entry.count++;
        entry.from = Math.min(entry.from, play.start);
        entry.to = Math.max(entry.to, play.end);
      } else {
        plays.set(play.line, { count: 1, from: play.start, to: play.end });
      }
    }
  }
  for (const [line, entry] of plays) {
    add(line, `${icons.playing} ${entry.count > 1 ? `×${entry.count} ` : ""}${span(entry.from, entry.to)}`);
  }
  return lines;
}

/** Markdown lines about what one line of a file makes on the timeline. */
export function hoverLines(data: Timeline, file: string, line: number, icons: Icons = ICONS): string[] {
  const wanted = pathKey(file);
  const at = (item: { file?: string | null; line?: number | null }) => here(item, wanted) && item.line === line;
  const out: string[] = [];
  for (const segment of data.segments ?? []) {
    const stops = segment.stops ?? [];
    if (at(segment)) {
      out.push(
        `${icons.segment} segment **${segment.name}** · ${clock(segment.start)}–${clock(segment.end)} · ` +
          `${(segment.end - segment.start).toFixed(1)} s · ${stops.length} stops`,
      );
    }
    stops.forEach((stop, i) => {
      if (at(stop)) {
        const name = stop.name ? `\`${stop.name}\`` : "(unnamed)";
        out.push(`${icons.stop} stop ${name} · ${clock(stop.time)} · ${i + 1} of ${stops.length} in **${segment.name}**`);
      }
    });
  }
  for (const marker of data.markers ?? []) {
    if (at(marker)) {
      out.push(`${icons.marker} marker \`${marker.name}\` · ${clock(marker.time)}`);
    }
  }
  for (const voiceover of data.voiceovers ?? []) {
    if (at(voiceover)) {
      out.push(
        `${icons.voiceover} voiceover \`${voiceover.key}\` · ${clock(voiceover.start)}–${clock(voiceover.end)} · ` +
          `${(voiceover.end - voiceover.start).toFixed(1)} s`,
      );
    }
  }
  const plays = (data.plays ?? []).filter(at);
  if (plays.length > 0) {
    const shown = plays.slice(0, 6).map((play) => `${clock(play.start)}–${clock(play.end)}`);
    const more = plays.length > 6 ? ` … ${plays.length - 6} more` : "";
    out.push(`${icons.playing} play${plays.length > 1 ? `s ×${plays.length}` : ""} · ${shown.join(", ")}${more}`);
  }
  return out;
}

/** Plays animating at `time`, for highlighting their lines while the preview plays. */
export function playsAt(data: Timeline, time: number): (TimelineSpan & { file: string; line: number })[] {
  return (data.plays ?? []).filter(
    (play): play is TimelineSpan & { file: string; line: number } =>
      Boolean(play.file && play.line) && play.start <= time + 1e-6 && time < play.end,
  );
}

export interface TimelineEntry {
  kind: "segment" | "section" | "stop" | "marker" | "voiceover";
  label: string;
  time: number;
  end?: number;
  file?: string;
  line?: number;
  /** The command that brings a preview there. */
  seek: { cmd: "seek"; segment?: string; time?: number };
  /** The segment this entry belongs to, for grouping. */
  segment?: string;
}

/**
 * The timeline in time order: each segment with its stops; markers and
 * voiceovers after the last entry at or before their time.
 */
export function entries(data: Timeline): TimelineEntry[] {
  const base: TimelineEntry[] = [];
  for (const segment of data.segments ?? []) {
    base.push({
      kind: segment.section ? "section" : "segment",
      label: segment.section ? `${segment.section} · ${segment.name}` : segment.name,
      time: segment.start,
      end: segment.end,
      file: segment.file ?? undefined,
      line: segment.line ?? undefined,
      seek: { cmd: "seek", segment: segment.name },
      segment: segment.name,
    });
    for (const stop of segment.stops ?? []) {
      base.push({
        kind: "stop",
        label: stop.name ? stop.name : "(stop)",
        time: stop.time,
        file: stop.file ?? undefined,
        line: stop.line ?? undefined,
        seek: { cmd: "seek", time: stop.time },
        segment: segment.name,
      });
    }
  }
  const extra: TimelineEntry[] = [];
  for (const marker of data.markers ?? []) {
    extra.push({
      kind: "marker",
      label: marker.name,
      time: marker.time,
      file: marker.file ?? undefined,
      line: marker.line ?? undefined,
      seek: { cmd: "seek", time: marker.time },
    });
  }
  for (const voiceover of data.voiceovers ?? []) {
    extra.push({
      kind: "voiceover",
      label: voiceover.key,
      time: voiceover.start,
      end: voiceover.end,
      file: voiceover.file ?? undefined,
      line: voiceover.line ?? undefined,
      seek: { cmd: "seek", time: voiceover.start },
    });
  }
  extra.sort((a, b) => a.time - b.time);
  for (const entry of extra) {
    let at = -1;
    base.forEach((known, i) => {
      if (known.time <= entry.time + 1e-9) {
        at = i;
      }
    });
    entry.segment = at >= 0 ? base[at].segment : undefined;
    base.splice(at + 1, 0, entry);
  }
  return base;
}
