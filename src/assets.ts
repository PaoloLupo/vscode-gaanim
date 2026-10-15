// Asset files: where names resolve, what exists, what a file is.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { which } from "./cli";
import { config } from "./config";
import { formatSize, isAbsolute } from "./core/assets";
import { base } from "./narration";
import { Project } from "./project";

/** Folders a relative name may resolve in, most likely first. */
export function bases(project: Project): string[] {
  const entryDir = path.dirname(project.entry);
  const list = [base(project), project.assetsDir, path.join(entryDir, "assets"), entryDir, project.root].map((dir) =>
    path.normalize(dir),
  );
  return [...new Set(list)];
}

/** The file a name in the scene refers to, or undefined when none exists. */
export function resolve(project: Project, name: string): string | undefined {
  if (isAbsolute(name)) {
    return fs.existsSync(name) ? path.normalize(name) : undefined;
  }
  return bases(project)
    .map((dir) => path.join(dir, name))
    .find((file) => fs.existsSync(file));
}

export interface AssetFile {
  /** Relative to the asset directory, with forward slashes. */
  name: string;
  path: string;
  size: number;
}

/** Files under the asset directory with one of `extensions` (any when false). */
export function files(project: Project, extensions: string[] | false): AssetFile[] {
  let root = project.assetsDir;
  if (!fs.existsSync(root)) {
    root = path.dirname(project.entry);
  }
  const wanted = new Set(extensions || []);
  const ignore = config.outline.ignore();
  const found: AssetFile[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 5 && !ignore.has(entry.name) && !entry.name.startsWith(".")) {
          walk(full, depth + 1);
        }
        continue;
      }
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (ext && (!extensions || wanted.has(ext))) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          // Listed anyway.
        }
        found.push({ name: path.relative(root, full).split(path.sep).join("/"), path: full, size });
      }
    }
  };
  walk(root, 1);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Markdown about a file: its size, and from ffprobe its pixels or length. */
export function describe(project: Project, file: string): Promise<string> {
  let size = "";
  try {
    size = formatSize(fs.statSync(file).size);
  } catch {
    // No size.
  }
  const lines = [`\`${path.relative(project.root, file) || file}\`  ${size}`];
  const ffprobe = which("ffprobe");
  if (!ffprobe) {
    return Promise.resolve(lines.join("\n"));
  }
  return new Promise((done) => {
    execFile(
      ffprobe,
      ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", file],
      { timeout: 5000, windowsHide: true },
      (_error, stdout) => {
        try {
          const info = JSON.parse(stdout) as {
            streams?: { width?: number; height?: number }[];
            format?: { duration?: string };
          };
          const picture = info.streams?.find((stream) => stream.width && stream.height);
          if (picture) {
            lines.push(`${picture.width} × ${picture.height} px`);
          }
          const duration = Number(info.format?.duration);
          if (duration > 0) {
            lines.push(`${duration.toFixed(2)} s`);
          }
        } catch {
          // Size only.
        }
        done(lines.join("  \n"));
      },
    );
  });
}

/** Seconds of an audio file, from ffprobe. */
export function audioDuration(file: string): Promise<number | undefined> {
  const ffprobe = which("ffprobe");
  if (!ffprobe) {
    return Promise.resolve(undefined);
  }
  return new Promise((done) => {
    execFile(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { timeout: 5000, windowsHide: true },
      (_error, stdout) => {
        const value = Number(stdout.trim());
        done(Number.isFinite(value) && value > 0 ? value : undefined);
      },
    );
  });
}
