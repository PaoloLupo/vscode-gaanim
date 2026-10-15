// File names given to asset calls: `media.image("logo.png")`, `audio("intro.wav")`…

const AUDIO = ["wav", "flac", "mp3", "m4a", "aac", "ogg", "opus"];

/** Calls whose first argument names a file, and the extensions they read; `false` takes any file. */
export const ASSET_CALLS: Record<string, string[] | false> = {
  image: ["png", "jpg", "jpeg", "webp"],
  svg: ["svg"],
  audio: AUDIO,
  sfx: AUDIO,
  sound: AUDIO,
  video: ["mp4"],
  lottie: ["json", "lottie"],
  gltf: ["gltf", "glb"],
  narration_script: ["md"],
  preload: false,
};

/** Extensions a recorded narration take may have. */
export const TAKE_EXTENSIONS = AUDIO;

export interface AssetReference {
  call: string;
  name: string;
  /** 1-based line. */
  line: number;
  /** 0-based column where the name starts. */
  start: number;
  /** 0-based column just after it. */
  end: number;
}

/** Literal file names given to asset calls in a document's lines. */
export function assetReferences(lines: string[]): AssetReference[] {
  const refs: AssetReference[] = [];
  lines.forEach((line, index) => {
    for (const quote of ['"', "'"]) {
      const pattern = new RegExp(`\\.([A-Za-z_]+)\\(\\s*[rRbBuU]?${quote}([^${quote}]*)${quote}`, "g");
      for (const match of line.matchAll(pattern)) {
        const [whole, call, name] = match;
        if (ASSET_CALLS[call] === undefined || name === "" || /[{}]/.test(name)) {
          continue;
        }
        const start = (match.index ?? 0) + whole.length - 1 - name.length;
        refs.push({ call, name, line: index + 1, start, end: start + name.length });
      }
    }
  });
  return refs;
}

/** A size as people read it. */
export function formatSize(size: number): string {
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${size} B`;
}

/** Whether a name is an absolute path on any system. */
export function isAbsolute(name: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(name) || name.startsWith("/");
}
