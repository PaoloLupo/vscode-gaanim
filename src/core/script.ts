// The talk's narration script, `narration/script.md`.
//
// Gaanim reads each `## name` section as the speaker notes of the segment of
// that name (ignoring case) or the text of `scene.voiceover("name")`, and a
// `[stop]` / `[stop name]` line as where the speaker advances. `# Title` ends
// a section, `###` lines are notes that are not read and HTML comments are
// ignored. This module reads it the same way.

/** The header Gaanim writes at the top of a new script. */
export const HEADER = [
  "# Script",
  "",
  '<!-- Each "## name" is the script of the slide of that name',
  '     or the text of scene.voiceover("name"). A [stop] line marks where',
  "     you advance. Save the file and the scene updates. -->",
];

export interface ScriptMark {
  /** `""` for a plain `[stop]`. */
  name: string;
  /** 1-based line. */
  line: number;
}

export interface ScriptSection {
  name: string;
  /** 1-based line of the `##` heading. */
  line: number;
  /** Last line with anything written on it. */
  last: number;
  /** Words read aloud. */
  words: number;
  /** What is read aloud, without marks, comments or author notes. */
  text: string;
  marks: ScriptMark[];
}

export interface Script {
  /** 1-based line of the `# Title`. */
  title?: number;
  sections: ScriptSection[];
}

/** The stop a line marks: `undefined` when it is no mark, `""` for `[stop]`. */
export function mark(line: string): string | undefined {
  const inner = /^\[(.*)\]$/.exec(line.trim())?.[1]?.trim();
  if (inner === undefined || inner.slice(0, 4).toLowerCase() !== "stop") {
    return undefined;
  }
  const rest = inner.slice(4);
  if (rest !== "" && !/^[\s:]/.test(rest)) {
    return undefined;
  }
  return rest.replace(/^\s*:/, "").trim();
}

/** Reads the sections of a script the way Gaanim does. */
export function parseScript(lines: string[]): Script {
  const script: Script = { sections: [] };
  let current: ScriptSection | undefined;
  const spoken: string[][] = [];
  let inComment = false;
  const close = (line: number) => {
    if (current) {
      current.last = line;
      current = undefined;
    }
  };
  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    // Drop HTML comments, which may span lines.
    let text = "";
    let rest = raw;
    while (rest !== "") {
      if (inComment) {
        const finish = rest.indexOf("-->");
        if (finish === -1) {
          rest = "";
        } else {
          rest = rest.slice(finish + 3);
          inComment = false;
        }
      } else {
        const start = rest.indexOf("<!--");
        if (start === -1) {
          text += rest;
          rest = "";
        } else {
          text += rest.slice(0, start);
          rest = rest.slice(start + 4);
          inComment = true;
        }
      }
    }
    text = text.trim();
    // Like Markdown, `#word` is text; a heading needs a space after its marks.
    const heading = /^(#+)(.*)$/.exec(text);
    const level = heading && (heading[2] === "" || /^\s/.test(heading[2])) ? heading[1].length : 0;
    if (level > 2) {
      // Notes for the author, not read.
    } else if (level === 2) {
      close(lineNumber - 1);
      const name = heading![2].trim().replace(/#+$/, "").trim();
      current = { name, line: lineNumber, last: lineNumber, words: 0, text: "", marks: [] };
      script.sections.push(current);
      spoken.push([]);
    } else if (level === 1) {
      close(lineNumber - 1);
      script.title ??= lineNumber;
    } else if (current) {
      const stop = mark(text);
      if (stop !== undefined) {
        current.marks.push({ name: stop, line: lineNumber });
      } else {
        for (const word of text.split(/\s+/)) {
          if (/[\p{L}\p{N}]/u.test(word)) {
            current.words++;
            spoken[spoken.length - 1].push(word);
          }
        }
      }
    }
  });
  close(lines.length);
  script.sections.forEach((section, i) => {
    while (section.last > section.line && (lines[section.last - 1] ?? "").trim() === "") {
      section.last--;
    }
    section.text = spoken[i].join(" ");
  });
  return script;
}

/** The section of a slide or voiceover, matched ignoring case. */
export function findSection(script: Script, name: string): ScriptSection | undefined {
  const wanted = name.toLowerCase();
  return script.sections.find((section) => section.name.toLowerCase() === wanted);
}

/** The section a 1-based line is in. */
export function sectionAt(script: Script, line: number): ScriptSection | undefined {
  let found: ScriptSection | undefined;
  for (const section of script.sections) {
    if (section.line <= line) {
      found = section;
    }
  }
  return found;
}

/** Seconds it takes to say `words` at `wpm` words per minute. */
export function spoken(words: number, wpm: number): number {
  return (words / Math.max(wpm, 1)) * 60;
}

export type Pace = "none" | "ok" | "tight" | "over";

/** Green within the target, amber up to 15 % over, red beyond. */
export function pace(seconds: number, target?: number): Pace {
  if (target === undefined) {
    return "none";
  }
  if (seconds <= target) {
    return "ok";
  }
  return seconds <= target * 1.15 ? "tight" : "over";
}

export interface SectionInsert {
  /** 0-based line before which the block goes. */
  at: number;
  lines: string[];
  /** 1-based line of the new heading once inserted. */
  heading: number;
}

/**
 * Where and what to insert for a missing `## name` section, with a mark per
 * stop, after the section of the slide before it.
 *
 * @param order Slide names in the order the code declares them.
 * @param stops The names of the slide's stops (`""` when unnamed).
 */
export function sectionInsert(lines: string[], order: string[], name: string, stops: string[]): SectionInsert {
  const script = parseScript(lines);
  let at = lines.length;
  const index = order.lastIndexOf(name);
  for (let j = index - 1; j >= 0; j--) {
    const before = findSection(script, order[j]);
    if (before) {
      at = before.last;
      break;
    }
  }
  const block = ["", `## ${name}`, ""];
  for (const stop of stops) {
    block.push(stop === "" ? "[stop]" : `[stop ${stop}]`, "");
  }
  if (at === lines.length && (lines[lines.length - 1] ?? "").trim() === "") {
    block.shift();
  }
  if (lines[at] !== undefined && lines[at].trim() === "") {
    block.pop();
  }
  return { at, lines: block, heading: at + (block[0] === "" ? 2 : 1) };
}
