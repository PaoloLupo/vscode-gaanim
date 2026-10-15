// Settings under `gaanim.*`.

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { OutlinePattern } from "./core/symbols";

export interface ExportPreset {
  ext: string;
  args?: string[];
  desc: string;
  /** Ask for a frame (marker or time) before exporting. */
  ask?: "frame";
  /** After exporting a bundle, make it lighter to publish with `gaanim pack --web`. */
  packWeb?: boolean;
}

export const PRESET_ORDER = ["mp4", "draft", "production", "webm", "mov", "gif", "webp", "pdf", "notes", "bundle", "web", "still"];

export const BUILTIN_PRESETS: Record<string, ExportPreset> = {
  mp4: { ext: "mp4", desc: "MP4 video, 1080p 60 fps" },
  draft: { ext: "mp4", args: ["--quality", "draft"], desc: "MP4 draft, 30 fps, fast" },
  production: { ext: "mp4", args: ["--quality", "production"], desc: "MP4, best encode" },
  webm: { ext: "webm", desc: "WebM video (VP9)" },
  mov: { ext: "mov", desc: "ProRes MOV for video editors" },
  gif: { ext: "gif", desc: "Animated GIF" },
  webp: { ext: "webp", desc: "Animated WebP" },
  pdf: { ext: "pdf", desc: "PDF, a page per stop" },
  notes: { ext: "pdf", args: ["--notes"], desc: "PDF with speaker notes" },
  bundle: { ext: "gaanim", desc: "Playback bundle (.gaanim)" },
  web: { ext: "gaanim", desc: "Bundle made lighter to publish on a page (pack --web)", packWeb: true },
  still: { ext: "png", ask: "frame", desc: "One PNG at a time or marker" },
};

function section(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("gaanim");
}

function get<T>(key: string, fallback: T): T {
  return section().get<T>(key, fallback);
}

/** `~` expanded. */
export function expandHome(value: string): string {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

export const config = {
  path: () => expandHome(get("path", "gaanim") || "gaanim"),
  projectsDir: () => {
    const dir = get("projectsDir", "");
    return dir ? path.resolve(expandHome(dir)) : undefined;
  },
  newGit: () => get("new.git", false),
  openIn: () => get<"ask" | "currentWindow" | "newWindow">("new.openIn", "ask"),
  preview: {
    args: () => get<string[]>("preview.args", []),
    editor: () => get("preview.editor", true),
    editorCommand: () => get("preview.editorCommand", ""),
    listen: () => get("preview.listen", true),
    marker: () => get("preview.marker", true),
    animating: () => get("preview.animating", true),
    followDelay: () => get("preview.followDelay", 120),
    followScript: () => get("preview.followScript", true),
  },
  present: {
    duration: () => get("present.duration", "") || undefined,
    monitor: () => get<number | null>("present.monitor", null) ?? undefined,
  },
  check: {
    onSave: () => get("check.onSave", true),
    strict: () => get("check.strict", false),
    debounce: () => get("check.debounce", 400),
    revealProblems: () => get<"errors" | "always" | "never">("check.revealProblems", "never"),
  },
  export: {
    open: () => get<"never" | "stills" | "always">("export.open", "stills"),
    presets: (): Record<string, ExportPreset> => {
      const merged: Record<string, ExportPreset> = { ...BUILTIN_PRESETS };
      for (const [name, preset] of Object.entries(get<Record<string, ExportPreset | null>>("export.presets", {}))) {
        if (preset === null) {
          delete merged[name];
        } else if (preset && typeof preset.ext === "string") {
          merged[name] = { ...merged[name], ...preset, desc: preset.desc ?? merged[name]?.desc ?? name };
        }
      }
      return merged;
    },
  },
  script: {
    path: () => get("script.path", "") || undefined,
    wpm: () => get("script.wpm", 150),
    follow: () => get("script.follow", true),
    timing: () => get("script.timing", true),
  },
  outline: {
    patterns: () => get<OutlinePattern[]>("outline.patterns", []),
    ignore: () =>
      new Set(get<string[]>("outline.ignore", [".venv", "venv", ".git", "__pycache__", "exports", "snapshots", "node_modules"])),
  },
  inlayHints: () => get("inlayHints", true),
  codeLens: () => get("codeLens", true),
  assetDiagnostics: () => get("assets.diagnostics", true),
  takeDiagnostics: () => get("takes.diagnostics", true),
  typst: () => get("typst.completion", true),
  live: {
    delay: () => get("live.delay", 700),
    quiet: () => get("live.quiet", true),
  },
  pythonEnvironment: () => get<"ask" | "always" | "never">("python.useProjectEnvironment", "ask"),
};

/** Where presets are listed: the built-in order, then the rest by name. */
export function presetNames(presets: Record<string, ExportPreset>): string[] {
  const known = PRESET_ORDER.filter((name) => presets[name]);
  const extra = Object.keys(presets)
    .filter((name) => !PRESET_ORDER.includes(name))
    .sort();
  return [...known, ...extra];
}
