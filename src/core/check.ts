// `gaanim check` output, plain or `--message-format json`, as problems with a place.

export type Severity = "error" | "warning";

export interface Problem {
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  severity: Severity;
  text: string;
}

export interface Report {
  status: "pass" | "warning" | "error";
  summary: string;
  problems: Problem[];
}

export interface LocateContext {
  root: string;
  /** Where a problem without a place goes: gaanim.toml, else the entry script. */
  fallback: string;
  /** Where a warning's text points: the line it names, its script mark, its stop or segment. */
  locate(text: string): { file: string; line: number } | undefined;
}

const GLYPHS: Record<string, "pass" | "warning" | "error" | "info"> = {
  "✓": "pass",
  "!": "warning",
  "✗": "error",
  "▸": "info",
};

export interface Entry {
  level: "pass" | "warning" | "error" | "info";
  label: string;
  text: string;
  more: string[];
}

/** Splits a plain report into entries: one per glyph line, with the lines after it (a traceback). */
export function entries(lines: string[]): Entry[] {
  const out: Entry[] = [];
  for (const line of lines) {
    const match = /^\s\s(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (match && GLYPHS[match[1]]) {
      out.push({ level: GLYPHS[match[1]], label: match[2], text: match[3], more: [] });
    } else if (out.length > 0 && !/^\[exit \d+\]$/.test(line)) {
      out[out.length - 1].more.push(line);
    }
  }
  return out;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

/** The traceback frame that points into the project, and the exception line that ends it. */
export function traceback(lines: string[], root: string): { frame?: { file: string; line: number }; message?: string } {
  let frame: { file: string; line: number } | undefined;
  let message: string | undefined;
  const base = normalize(root).toLowerCase();
  for (const line of lines) {
    const found = /File "(.*?)", line (\d+)/.exec(line);
    if (found && !found[1].startsWith("<")) {
      const path = normalize(found[1]);
      if (path.toLowerCase().startsWith(base) || !frame) {
        frame = { file: path, line: Number(found[2]) };
      }
    }
    const exception = /^\s*([\w.]+(?:Error|Exception|Warning): .*)$/.exec(line);
    if (exception) {
      message = exception[1];
    }
  }
  if (!message) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() !== "") {
        message = lines[i].trim();
        break;
      }
    }
  }
  return { frame, message };
}

/** Turns the plain output of `gaanim check` into a report. */
export function fromText(lines: string[], context: LocateContext): Report {
  const report: Report = { status: "pass", summary: "", problems: [] };
  for (const entry of entries(lines)) {
    if (entry.level === "pass") {
      report.summary = entry.text;
    } else if (entry.level === "error") {
      report.status = "error";
      const { frame, message } = traceback(entry.more, context.root);
      const text = entry.more.length === 0 ? entry.text : (message ?? entry.text);
      report.problems.push({
        file: frame?.file ?? context.fallback,
        line: frame?.line ?? 1,
        column: 1,
        severity: "error",
        text,
      });
      report.summary = text;
    } else if (entry.level === "warning") {
      if (report.status === "pass") {
        report.status = "warning";
      }
      const place = context.locate(entry.text);
      report.problems.push({
        file: place?.file ?? context.fallback,
        line: place?.line ?? 1,
        column: 1,
        severity: "warning",
        text: entry.text,
      });
    }
  }
  return report;
}

interface JsonMessage {
  type?: string;
  level?: string;
  label?: string;
  message?: string;
  file?: string | null;
  line?: number | null;
  column?: number | null;
  result?: string;
  segments?: number;
  stops?: number;
  duration?: number;
}

/**
 * Turns the JSON lines of `--message-format json` into a report. Gaanim gives
 * each diagnostic its file and line; a traceback (in the message, or on
 * stderr in `lines`) still places a script that failed to load.
 */
export function fromJson(objects: unknown[], lines: string[], context: LocateContext): Report {
  const report: Report = { status: "pass", summary: "", problems: [] };
  for (const raw of objects) {
    const object = raw as JsonMessage;
    if (object.type === "diagnostic" || (object.type === "message" && object.level === "error")) {
      const failed = object.level === "error";
      let file = object.file ? normalize(object.file) : undefined;
      let line = object.line ?? undefined;
      let message = object.message ?? "";
      if (!file && message.includes("Traceback")) {
        // A script that failed to load: its traceback is in the message.
        const found = traceback(message.split("\n"), context.root);
        if (found.frame) {
          file = found.frame.file;
          line = found.frame.line;
        }
        message = found.message ?? message;
      }
      if (!file) {
        if (failed) {
          const found = traceback(lines, context.root);
          file = found.frame?.file;
          line = found.frame?.line;
        } else {
          const place = context.locate(message);
          file = place?.file;
          line = place?.line;
        }
      }
      report.problems.push({
        file: file ?? context.fallback,
        line: line ?? 1,
        column: object.column ?? 1,
        severity: failed ? "error" : "warning",
        text: message,
      });
      if (failed) {
        report.status = "error";
        report.summary = message || report.summary;
      } else if (report.status === "pass") {
        report.status = "warning";
      }
    } else if (object.type === "check") {
      const parts: string[] = [];
      if (object.segments !== undefined) {
        parts.push(`${object.segments} segments`);
      }
      if (object.stops !== undefined) {
        parts.push(`${object.stops} stops`);
      }
      if (object.duration !== undefined) {
        parts.push(`${object.duration.toFixed(1)} s`);
      }
      if (report.status !== "error") {
        report.summary = `${object.result === "fail" ? "fail" : "ready"} · ${parts.join(" · ")}`;
        if (object.result === "fail") {
          report.status = "error";
        }
      }
    }
  }
  return report;
}

/**
 * Pieces of a warning's text that say where it belongs: a Markdown file and
 * line, a segment, a `[stop]` mark it quotes, a stop name.
 */
export function warningRefs(text: string): {
  markdown?: { file: string; line: number };
  segment?: string;
  mark?: string;
  stop?: string;
} {
  const markdown = /^([^:\s]+\.md): .*?\(line (\d+)\)/.exec(text);
  return {
    markdown: markdown ? { file: markdown[1], line: Number(markdown[2]) } : undefined,
    segment: (/^segment `(.*?)`/.exec(text) ?? /^section `(.*?)`/.exec(text) ?? /segment `(.*?)`/.exec(text))?.[1],
    mark: /is (\[stop[^\]]*\])/.exec(text)?.[1],
    stop: (/stop \d+ is `(.*?)`/.exec(text) ?? /stop `(.*?)`/.exec(text))?.[1],
  };
}
