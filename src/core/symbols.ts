// Segments, sections, stops, markers and voiceovers as the Python writes them.
//
// The scanner reads the scene's structure the way it is written
// (`scene.segment("Intro")`, `scene.stop()`), without running it, so names
// built at run time are missed unless a pattern from `gaanim.outline.patterns`
// describes the project's own convention. The timeline from `gaanim inspect`
// covers the rest.

export type SymbolKind =
  | "segment"
  | "section"
  | "stop"
  | "marker"
  | "voiceover"
  | "script"
  | "assets"
  | "talk";

export interface SceneSymbol {
  kind: SymbolKind;
  /** Undefined for an unnamed stop. */
  name?: string;
  file: string;
  /** 1-based line. */
  line: number;
  /** 0-based column, in UTF-16 code units. */
  column: number;
  /** Planned seconds of a segment, or of the whole talk. */
  target?: number;
  /** Title of a `Section`. */
  title?: string;
}

export interface OutlinePattern {
  kind: SymbolKind;
  /** A JavaScript regular expression; its first group is the name. */
  pattern: string;
}

const Q = "[\"']";
const NAME = "([^\"'\\n]*)";

interface CompiledPattern {
  kind: SymbolKind;
  regex: RegExp;
}

const BUILTIN: { kind: SymbolKind; source: string }[] = [
  { kind: "segment", source: `\\.segment\\(\\s*${Q}${NAME}${Q}` },
  { kind: "segment", source: `\\.segment\\(\\s*name\\s*=\\s*${Q}${NAME}${Q}` },
  { kind: "section", source: `(?<![\\w])Section\\(\\s*${Q}${NAME}${Q}` },
  { kind: "stop", source: `\\.stop\\(\\s*${Q}${NAME}${Q}` },
  { kind: "stop", source: `\\.stop\\(\\s*\\)` },
  { kind: "marker", source: `\\.marker\\(\\s*${Q}${NAME}${Q}` },
  { kind: "voiceover", source: `\\.voiceover\\(\\s*${Q}${NAME}${Q}` },
  // Not shown in the outline: they tell where the script is and how long
  // the talk should last.
  { kind: "script", source: `\\.narration_script\\(\\s*${Q}${NAME}${Q}` },
  { kind: "assets", source: `\\.load_project\\(\\s*\\)` },
  { kind: "assets", source: `\\.assets_dir\\(\\s*${Q}${NAME}${Q}` },
  { kind: "talk", source: `\\.target\\(\\s*([\\d.\\s*+\\-/()]+)\\)` },
];

/** Kinds that make up the scene's structure, as the outline shows it. */
export const STRUCTURE: ReadonlySet<SymbolKind> = new Set(["segment", "section", "voiceover", "stop", "marker"]);

/** Kinds that open a slide: what the script's `## name` sections are about. */
export const SLIDE_KINDS: ReadonlySet<SymbolKind> = new Set(["segment", "section", "voiceover"]);

function compile(extra: OutlinePattern[]): CompiledPattern[] {
  const patterns: CompiledPattern[] = BUILTIN.map((spec) => ({ kind: spec.kind, regex: new RegExp(spec.source, "g") }));
  for (const spec of extra) {
    try {
      patterns.push({ kind: spec.kind, regex: new RegExp(spec.pattern, "g") });
    } catch {
      // A broken user pattern is skipped; the settings UI shows the text.
    }
  }
  return patterns;
}

/** True when the text before a match, on its line, opens a comment. */
function inComment(prefix: string): boolean {
  let quote: string | undefined;
  for (const c of prefix) {
    if (quote) {
      if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return true;
    }
  }
  return false;
}

/** The text of a call's arguments, from just after `(` to its matching `)`. */
export function callArgs(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  const limit = Math.min(text.length, open + 4000);
  for (let i = open; i < limit; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
      } else if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, i);
      }
    }
  }
  return text.slice(open + 1, limit);
}

/** Evaluates a plain arithmetic literal such as `4 * 60` or `90`; undefined otherwise. */
export function evalNumber(expr: string): number | undefined {
  const source = expr.trim();
  if (source === "" || !/^[\d.\s*+\-/()]+$/.test(source)) {
    return undefined;
  }
  let pos = 0;
  const peek = () => {
    while (source[pos] === " " || source[pos] === "\t" || source[pos] === "\n") {
      pos++;
    }
    return source[pos];
  };
  const factor = (): number => {
    const c = peek();
    if (c === "-" || c === "+") {
      pos++;
      const value = factor();
      return c === "-" ? -value : value;
    }
    if (c === "(") {
      pos++;
      const value = sum();
      if (peek() !== ")") {
        throw new Error("unbalanced");
      }
      pos++;
      return value;
    }
    const match = /^(?:\d+\.?\d*|\.\d+)/.exec(source.slice(pos));
    if (!match) {
      throw new Error("number expected");
    }
    pos += match[0].length;
    return Number(match[0]);
  };
  const product = (): number => {
    let value = factor();
    for (;;) {
      const c = peek();
      if (c === "*" && source[pos + 1] === "*") {
        pos += 2;
        value = value ** factor();
      } else if (c === "*" || c === "/") {
        pos++;
        const right = factor();
        value = c === "*" ? value * right : value / right;
      } else {
        return value;
      }
    }
  };
  const sum = (): number => {
    let value = product();
    for (;;) {
      const c = peek();
      if (c === "+" || c === "-") {
        pos++;
        const right = product();
        value = c === "+" ? value + right : value - right;
      } else {
        return value;
      }
    }
  };
  try {
    const value = sum();
    return peek() === undefined && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function position(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo + 1, column: offset - starts[lo] };
}

/** Finds every symbol in a piece of Python source, in line order. */
export function parseSymbols(source: string, file: string, extra: OutlinePattern[] = []): SceneSymbol[] {
  const text = source.replace(/\r\n/g, "\n");
  const starts = lineStarts(text);
  const symbols: SceneSymbol[] = [];
  const seen = new Set<string>();
  for (const spec of compile(extra)) {
    for (const match of text.matchAll(spec.regex)) {
      const start = match.index ?? 0;
      const { line, column } = position(starts, start);
      const key = `${line}:${column}`;
      if (seen.has(key) || inComment(text.slice(starts[line - 1], start))) {
        continue;
      }
      seen.add(key);
      const symbol: SceneSymbol = { kind: spec.kind, file, line, column };
      const name = match[1];
      if (spec.kind === "talk") {
        symbol.target = evalNumber(name ?? "");
      } else {
        if (typeof name === "string" && name !== "") {
          symbol.name = name;
        }
        const open = text.indexOf("(", start);
        if (open !== -1 && open < start + match[0].length) {
          const args = callArgs(text, open);
          if (spec.kind === "segment") {
            const expr = /target\s*=\s*([^,\n]+)/.exec(args);
            symbol.target = expr ? evalNumber(expr[1].replace(/\)\s*$/, "")) : undefined;
          } else if (spec.kind === "section") {
            const title = new RegExp(`title\\s*=\\s*${Q}${NAME}${Q}`).exec(args);
            symbol.title = title?.[1];
          }
        }
      }
      symbols.push(symbol);
    }
  }
  symbols.sort((a, b) => a.line - b.line || a.column - b.column);
  return symbols;
}

export interface SlideAt {
  /** The last segment, section or voiceover declared at or above the line. */
  segment?: SceneSymbol;
  /** The last stop between it and the line. */
  stop?: SceneSymbol;
  /** How many stops of the slide come before the line (1-based for `stop`). */
  stopIndex: number;
}

/** The slide around a 1-based line of a file, from that file's symbols. */
export function slideAt(symbols: SceneSymbol[], line: number): SlideAt {
  const result: SlideAt = { stopIndex: 0 };
  for (const symbol of symbols) {
    if (symbol.line > line) {
      break;
    }
    if (SLIDE_KINDS.has(symbol.kind) && symbol.name) {
      result.segment = symbol;
      result.stop = undefined;
      result.stopIndex = 0;
    } else if (symbol.kind === "stop") {
      result.stop = symbol;
      result.stopIndex++;
    }
  }
  return result;
}

/** The variable the scene goes by around a line (`scene` when unsure). */
export function receiver(lines: string[], line: number): string {
  for (let row = Math.min(line, lines.length); row >= 1; row--) {
    const match = /([A-Za-z_]\w*)\.(?:play|stop|wait|segment|marker)\(/.exec(lines[row - 1] ?? "");
    if (match) {
      return match[1];
    }
  }
  return "scene";
}

/** A Python string literal for a name. */
export function pythonString(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
