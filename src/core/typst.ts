// Typst math inside scene strings: where it is, and what to complete.
//
// Gaanim reads Typst math in two places of a scene's Python: every string
// passed to `equation(...)` (`scene.text.equation("x^2 + y")`, without `$`),
// and the `$...$` spans of any other text. The scanner walks the Python up to
// the cursor (strings, comments, brackets) without a parser.

import table from "./typstSymbols.json";

export interface StringContext {
  /** The cursor is in Typst math. */
  math: boolean;
  /** Last name of the call whose argument the string is. */
  call?: string;
  /** The string is a keyword argument (`color="..."`). */
  keyword: boolean;
  /** String content from its start to the cursor. */
  content: string;
  /** Dotted name being typed (`arrow.r.do`), maybe "". */
  prefix: string;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);

function escaped(text: string, i: number): boolean {
  let count = 0;
  for (let j = i - 1; j >= 0 && text[j] === "\\"; j--) {
    count++;
  }
  return count % 2 === 1;
}

function dollars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && !escaped(text, i)) {
      count++;
    }
  }
  return count;
}

/** Describes the string the end of `text` (source up to the cursor) is in, or undefined outside strings. */
export function scan(text: string): StringContext | undefined {
  const stack: { char: string; name?: string; sep: number }[] = [];
  let i = 0;
  const n = text.length;
  let stringStart: number | undefined;
  let quote = "";
  let triple = false;
  let raw = false;
  while (i < n) {
    const c = text[i];
    if (stringStart !== undefined) {
      if (c === "\\" && !raw) {
        i += 2;
      } else if (triple && text.startsWith(quote.repeat(3), i)) {
        stringStart = undefined;
        i += 3;
      } else if (!triple && c === quote) {
        stringStart = undefined;
        i++;
      } else if (!triple && c === "\n") {
        // An unclosed one-line string ends with its line.
        stringStart = undefined;
        i++;
      } else {
        i++;
      }
    } else if (c === "#") {
      const newline = text.indexOf("\n", i);
      if (newline === -1) {
        return undefined;
      }
      i = newline + 1;
    } else if (c === '"' || c === "'") {
      let prefix = /([A-Za-z]*)$/.exec(text.slice(Math.max(0, i - 3), i))?.[1] ?? "";
      const before = text[i - prefix.length - 1] ?? "";
      if (prefix.length > 2 || !/^[rbfu]*$/i.test(prefix) || /[\w]/.test(before)) {
        prefix = "";
      }
      raw = prefix.toLowerCase().includes("r");
      quote = c;
      triple = text.startsWith(c.repeat(3), i);
      i += triple ? 3 : 1;
      stringStart = i;
    } else if (OPEN[c]) {
      const name = c === "(" ? /([A-Za-z_][\w.]*)\s*$/.exec(text.slice(Math.max(0, i - 120), i))?.[1] : undefined;
      stack.push({ char: c, name, sep: i });
      i++;
    } else if (CLOSE.has(c)) {
      stack.pop();
      i++;
    } else {
      if (c === "," && stack.length > 0) {
        stack[stack.length - 1].sep = i;
      }
      i++;
    }
  }
  if (stringStart === undefined) {
    return undefined;
  }
  const content = text.slice(stringStart);
  const frame = stack[stack.length - 1];
  let call: string | undefined;
  let keyword = false;
  if (frame && frame.char === "(") {
    call = frame.name ? /([A-Za-z_]\w*)$/.exec(frame.name)?.[1] : undefined;
    const opening = stringStart - (triple ? 3 : 1);
    const before = text.slice(frame.sep + 1, opening).replace(/[A-Za-z]*$/, "");
    keyword = /[A-Za-z_]\w*\s*=\s*$/.test(before);
  }
  const equation = call === "equation" && !keyword;
  const math = equation || dollars(content) % 2 === 1;
  let prefix = "";
  if (math) {
    prefix = /([A-Za-z][\w.]*)$/.exec(content)?.[1] ?? "";
    const before = content.slice(0, content.length - prefix.length);
    // `#name` is Typst code, and `\name` an escape: not math names.
    if (/[#\\]$/.test(before)) {
      return { math: false, call, keyword, content, prefix: "" };
    }
  }
  return { math, call, keyword, content, prefix };
}

export type ItemKind = "symbol" | "function" | "accent" | "operator" | "space";

export interface MathItem {
  label: string;
  kind: ItemKind;
  /** What the menu shows beside the label: the glyph, or the call shape. */
  detail: string;
  insertText: string;
  snippet: boolean;
  filterText?: string;
  documentation: string;
}

/** Typst's math functions: name, snippet, what it does. */
export const FUNCTIONS: [string, string, string][] = [
  ["frac", "frac(${1:a}, ${2:b})", "Fraction"],
  ["binom", "binom(${1:n}, ${2:k})", "Binomial coefficient"],
  ["sqrt", "sqrt(${1:x})", "Square root"],
  ["root", "root(${1:n}, ${2:x})", "n-th root"],
  ["vec", "vec(${1:a}, ${2:b})", "Column vector"],
  ["mat", "mat(${1:a}, ${2:b}; ${3:c}, ${4:d})", "Matrix: `,` between columns, `;` between rows"],
  ["cases", 'cases(${1:a} "if" ${2:x > 0}, ${3:b} "otherwise")', "Cases with a brace"],
  ["lr", "lr(${1:( x )})", "Scale delimiters to their content"],
  ["mid", "mid(${1:|})", "Delimiter scaled in the middle of `lr`"],
  ["abs", "abs(${1:x})", "Absolute value |x|"],
  ["norm", "norm(${1:x})", "Norm ‖x‖"],
  ["floor", "floor(${1:x})", "Floor ⌊x⌋"],
  ["ceil", "ceil(${1:x})", "Ceiling ⌈x⌉"],
  ["round", "round(${1:x})", "Round ⌊x⌉"],
  ["attach", "attach(${1:base}, t: ${2:top}, b: ${3:bottom})", "Attachments: t, b, tl, bl, tr, br"],
  ["scripts", "scripts(${1:x})", "Attachments as sub/superscripts"],
  ["limits", "limits(${1:x})", "Attachments as limits above and below"],
  ["stretch", "stretch(${1:arrow.r}, size: ${2:200%})", "Stretch a glyph"],
  ["accent", "accent(${1:x}, ${2:arrow})", "Accent over a base"],
  ["underline", "underline(${1:x})", "Line under"],
  ["overline", "overline(${1:x})", "Line over"],
  ["underbrace", "underbrace(${1:x}, ${2:label})", "Brace under, with a label"],
  ["overbrace", "overbrace(${1:x}, ${2:label})", "Brace over, with a label"],
  ["underbracket", "underbracket(${1:x}, ${2:label})", "Bracket under"],
  ["overbracket", "overbracket(${1:x}, ${2:label})", "Bracket over"],
  ["underparen", "underparen(${1:x}, ${2:label})", "Parenthesis under"],
  ["overparen", "overparen(${1:x}, ${2:label})", "Parenthesis over"],
  ["undershell", "undershell(${1:x}, ${2:label})", "Shell bracket under"],
  ["overshell", "overshell(${1:x}, ${2:label})", "Shell bracket over"],
  ["cancel", "cancel(${1:x})", "Strike through"],
  ["class", 'class("${1:normal}", ${2:x})', "Spacing class of an expression"],
  ["op", 'op("${1:name}")', "A text operator"],
  ["primes", "primes(${1:2})", "Prime marks"],
  ["upright", "upright(${1:x})", "Upright letters"],
  ["italic", "italic(${1:x})", "Italic letters"],
  ["bold", "bold(${1:x})", "Bold letters"],
  ["serif", "serif(${1:x})", "Serif letters"],
  ["sans", "sans(${1:x})", "Sans-serif letters"],
  ["cal", "cal(${1:x})", "Calligraphic letters"],
  ["scr", "scr(${1:x})", "Script letters"],
  ["frak", "frak(${1:x})", "Fraktur letters"],
  ["mono", "mono(${1:x})", "Monospace letters"],
  ["bb", "bb(${1:x})", "Blackboard bold letters"],
  ["display", "display(${1:x})", "Display size"],
  ["inline", "inline(${1:x})", "Inline size"],
  ["script", "script(${1:x})", "Script size"],
  ["sscript", "sscript(${1:x})", "Second-level script size"],
];

/** Accents that work as functions: `hat(x)`. */
export const ACCENTS = [
  "grave", "acute", "hat", "tilde", "macron", "dash", "breve", "dot", "dot.double", "dot.triple",
  "dot.quad", "diaer", "circle", "acute.double", "caron", "arrow", "arrow.l", "arrow.l.r", "harpoon", "harpoon.lt",
];

/** Text operators, upright with their spacing. */
export const OPERATORS = [
  "arccos", "arcsin", "arctan", "arg", "cos", "cosh", "cot", "coth", "csc", "csch", "ctg", "deg", "det", "dim",
  "exp", "gcd", "lcm", "hom", "id", "im", "inf", "ker", "lg", "lim", "liminf", "limsup", "ln", "log", "max",
  "min", "mod", "Pr", "sec", "sech", "sin", "sinc", "sinh", "sup", "tan", "tanh", "tg", "tr",
];

/** Spacing between math parts. */
export const SPACES: [string, string][] = [
  ["med", "2/9 em"],
  ["quad", "1 em"],
  ["thick", "5/18 em"],
  ["thin", "1/6 em"],
  ["wide", "2 em"],
];

/** The codex version the symbol names come from. */
export const CODEX_VERSION: string = table.version;

const SYMBOLS: [string, string][] = table.symbols as [string, string][];
const TEXT = new Map<string, string>(SYMBOLS);

function isBlank(code: number): boolean {
  return (
    code <= 0x20 ||
    code === 0xa0 ||
    (code >= 0x2000 && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202f) ||
    (code >= 0x205f && code <= 0x206f) ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** What a menu can show for a character: combining marks get a dotted circle, blanks a visible sign. */
export function glyph(text: string): string {
  const codes = [...text].map((c) => c.codePointAt(0) ?? 0);
  if (codes.every(isBlank)) {
    return "␣";
  }
  const first = codes[0];
  const combining =
    (first >= 0x0300 && first <= 0x036f) ||
    (first >= 0x1ab0 && first <= 0x1aff) ||
    (first >= 0x1dc0 && first <= 0x1dff) ||
    (first >= 0x20d0 && first <= 0x20ff) ||
    (first >= 0xfe20 && first <= 0xfe2f);
  return combining ? `◌${text}` : text;
}

function codepoints(text: string): string {
  return [...text].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");
}

/** Symbol names one level under `parent` ("" for the top level), with the character of each. */
function symbolsUnder(parent: string): { label: string; name: string; text: string }[] {
  const list: { label: string; name: string; text: string }[] = [];
  if (parent === "") {
    const seen = new Set<string>();
    for (const [name] of SYMBOLS) {
      const base = name.split(".")[0];
      if (!seen.has(base)) {
        seen.add(base);
        list.push({ label: base, name: base, text: TEXT.get(base) ?? TEXT.get(name) ?? "" });
      }
    }
    return list;
  }
  const start = `${parent}.`;
  for (const [name, text] of SYMBOLS) {
    if (name.startsWith(start)) {
      list.push({ label: name.slice(start.length), name, text });
    }
  }
  return list;
}

function plain(snippet: string): string {
  return snippet.replace(/\$\{\d+:([^}]*)\}/g, "$1");
}

/**
 * Completion items for a dotted name being typed in math: under `arrow.r.`
 * the variants of `arrow.r`; with no dot, symbols, functions, accents,
 * operators and spaces.
 */
export function mathItems(prefix: string): MathItem[] {
  const parent = /^(.*)\.[^.]*$/.exec(prefix)?.[1] ?? "";
  const items: MathItem[] = symbolsUnder(parent).map((symbol) => ({
    label: symbol.label,
    kind: "symbol",
    detail: glyph(symbol.text),
    insertText: symbol.label,
    snippet: false,
    documentation: `\`${symbol.name}\`  ${glyph(symbol.text)}  ${codepoints(symbol.text)}\n\nTypst math symbol (codex ${CODEX_VERSION})`,
  }));
  const accent = (name: string, label: string): MathItem => ({
    label: `${label}(…)`,
    filterText: label,
    kind: "accent",
    detail: "accent",
    insertText: `${label}(\${1:x})`,
    snippet: true,
    documentation: `\`${name}(x)\`: accent over x`,
  });
  if (parent !== "") {
    for (const name of ACCENTS) {
      if (name.startsWith(`${parent}.`)) {
        items.push(accent(name, name.slice(parent.length + 1)));
      }
    }
    return items;
  }
  for (const [name, body, what] of FUNCTIONS) {
    items.push({
      label: `${name}(…)`,
      filterText: name,
      kind: "function",
      detail: plain(body),
      insertText: body,
      snippet: true,
      documentation: `\`${name}\`: ${what}`,
    });
  }
  for (const name of ACCENTS) {
    if (!name.includes(".")) {
      items.push(accent(name, name));
    }
  }
  for (const name of OPERATORS) {
    items.push({
      label: name,
      kind: "operator",
      detail: "operator",
      insertText: name,
      snippet: false,
      documentation: `\`${name}\`: upright text operator`,
    });
  }
  for (const [name, size] of SPACES) {
    items.push({
      label: name,
      kind: "space",
      detail: `space ${size}`,
      insertText: name,
      snippet: false,
      documentation: `\`${name}\`: math space of ${size}`,
    });
  }
  return items;
}
