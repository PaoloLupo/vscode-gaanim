// The take inspector: where each `vo.wait_until("word")` will land.
//
// A voiceover's markers resolve in order the way Gaanim does: a mark tapped
// while recording, else the word in the take's transcript, else the
// proportional position of the word in the script, else nowhere (the scene
// does not wait). Recorded takes keep their timings in `narration/<key>.json`.

export type MarkerSource = "tapped" | "transcript" | "estimated" | "missing";

export interface TakeSidecar {
  markers?: Record<string, number>;
  words?: { text: string; start: number; end: number }[];
}

const ACCENTS: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", ã: "a", å: "a",
  é: "e", è: "e", ë: "e", ê: "e",
  í: "i", ì: "i", ï: "i", î: "i",
  ó: "o", ò: "o", ö: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", ü: "u", û: "u",
  ñ: "n", ç: "c",
};

/** Lowercase, without accents or punctuation: `"¿Derivada?"` matches `derivada`. */
export function normalizeWord(word: string): string {
  let out = "";
  for (const c of word.toLowerCase()) {
    const folded = ACCENTS[c] ?? c;
    if (/[\p{L}\p{N}]/u.test(folded)) {
      out += folded;
    }
  }
  return out;
}

export function textWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter((word) => word !== "");
}

/** First index at or after `from` where `phrase` occurs in `words`. */
export function findPhrase(words: string[], phrase: string[], from: number): number | undefined {
  if (phrase.length === 0 || phrase.length > words.length) {
    return undefined;
  }
  for (let index = from; index <= words.length - phrase.length; index++) {
    if (phrase.every((word, i) => words[index + i] === word)) {
      return index;
    }
  }
  return undefined;
}

export interface Resolution {
  source: MarkerSource;
  /** Seconds into the take, when known. */
  offset?: number;
}

/** Resolves a voiceover's markers in the order the script asks for them. */
export class TakeTiming {
  private readonly markers: Record<string, number>;
  private readonly transcript: [string, number][];
  private readonly text: string[];
  private textCursor = 0;
  private transcriptCursor = 0;

  /**
   * @param recorded Whether a take file exists; tapped marks and words
   * describe that file, so they count only with it.
   * @param duration Seconds of the take, when known.
   */
  constructor(
    readonly recorded: boolean,
    private readonly duration: number | undefined,
    sidecar: TakeSidecar,
    script: string | undefined,
  ) {
    this.markers = recorded ? (sidecar.markers ?? {}) : {};
    this.transcript = recorded
      ? (sidecar.words ?? []).flatMap((word) => textWords(word.text).map((token): [string, number] => [token, word.start]))
      : [];
    this.text = script ? textWords(script) : [];
  }

  get transcribed(): boolean {
    return this.transcript.length > 0;
  }

  resolve(name: string): Resolution {
    const phrase = textWords(name);
    const normalized = phrase.join("");
    let tapped: number | undefined = this.markers[name];
    if (tapped === undefined) {
      for (const [key, time] of Object.entries(this.markers)) {
        if (textWords(key).join("") === normalized) {
          tapped = time;
          break;
        }
      }
    }
    const textHit = findPhrase(this.text, phrase, this.textCursor);
    if (textHit !== undefined) {
      this.textCursor = textHit + phrase.length;
    }
    if (tapped !== undefined) {
      return { source: "tapped", offset: tapped };
    }
    const tokens = this.transcript.map(([token]) => token);
    const heard = findPhrase(tokens, phrase, this.transcriptCursor);
    if (heard !== undefined) {
      this.transcriptCursor = heard + phrase.length;
      return { source: "transcript", offset: this.transcript[heard][1] };
    }
    if (textHit !== undefined && this.text.length > 0 && this.duration !== undefined && this.recorded) {
      return { source: "estimated", offset: (this.duration * textHit) / this.text.length };
    }
    if (textHit !== undefined) {
      return { source: "estimated" };
    }
    return { source: "missing" };
  }
}

export interface MarkerCall {
  name: string;
  method: "wait_until" | "until";
  /** 1-based line. */
  line: number;
  /** 0-based columns of the name inside its quotes. */
  start: number;
  end: number;
}

export interface VoiceoverBlock {
  key: string;
  /** 1-based line of the voiceover call. */
  line: number;
  variable: string;
  /** The `text=` literal, which replaces the script's section. */
  text?: string;
  markers: MarkerCall[];
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

/**
 * The voiceover blocks of a scene and the markers each asks for:
 * `with scene.voiceover("key") as vo:` (until the block's indentation ends)
 * and `vo = scene.voiceover("key", ...)` (until `vo.finish()` or `vo` is
 * assigned again).
 */
export function voiceoverBlocks(lines: string[]): VoiceoverBlock[] {
  const blocks: VoiceoverBlock[] = [];
  lines.forEach((line, index) => {
    const withForm = /^(\s*)with\s+.*?\.voiceover\(\s*["']([^"'\n]+)["'](.*?)\)\s*as\s+([A-Za-z_]\w*)\s*:/.exec(line);
    const assigned = /^(\s*)([A-Za-z_]\w*)\s*=\s*[\w.]*\.voiceover\(\s*["']([^"'\n]+)["'](.*)$/.exec(line);
    if (!withForm && !assigned) {
      return;
    }
    const key = withForm ? withForm[2] : assigned![3];
    const variable = withForm ? withForm[4] : assigned![2];
    const args = withForm ? withForm[3] : assigned![4];
    const text = /text\s*=\s*["']([^"']*)["']/.exec(args)?.[1];
    const block: VoiceoverBlock = { key, line: index + 1, variable, text, markers: [] };
    const indent = indentOf(line);
    const call = new RegExp(`\\b${variable}\\.(wait_until|until)\\(\\s*(["'])([^"'\\n]*)\\2`, "g");
    for (let row = index + 1; row < lines.length; row++) {
      const body = lines[row];
      if (body.trim() === "" || body.trim().startsWith("#")) {
        continue;
      }
      if (withForm && indentOf(body) <= indent) {
        break;
      }
      if (!withForm && new RegExp(`^\\s*${variable}\\s*=`).test(body)) {
        break;
      }
      for (const match of body.matchAll(call)) {
        const start = (match.index ?? 0) + match[0].length - 1 - match[3].length;
        block.markers.push({
          name: match[3],
          method: match[1] as "wait_until" | "until",
          line: row + 1,
          start,
          end: start + match[3].length,
        });
      }
      if (!withForm && new RegExp(`\\b${variable}\\.finish\\(`).test(body)) {
        break;
      }
    }
    blocks.push(block);
  });
  return blocks;
}
