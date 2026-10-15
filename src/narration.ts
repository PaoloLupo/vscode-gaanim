// Where the narration script and the recorded takes live.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { isAbsolute, TAKE_EXTENSIONS } from "./core/assets";
import { parseScript, Script } from "./core/script";
import { SceneSymbol } from "./core/symbols";
import { TakeSidecar } from "./core/takes";
import { Project, projectSymbols } from "./project";

/** The folder relative names resolve in: the asset directory when the scene sets one, else the entry's folder. */
export function base(project: Project, symbols: SceneSymbol[] = projectSymbols(project)): string {
  const assets = symbols.find((symbol) => symbol.kind === "assets");
  if (assets) {
    return assets.name ? path.join(project.root, assets.name) : project.assetsDir;
  }
  return path.dirname(project.entry);
}

/** Where the project's script is, or would be, and whether it exists. */
export function scriptPath(project: Project): { path: string; exists: boolean } {
  const symbols = projectSymbols(project);
  const dir = base(project, symbols);
  const candidates: string[] = [];
  const configured = config.script.path();
  if (configured) {
    candidates.push(path.join(project.root, configured));
  }
  for (const symbol of symbols) {
    if (symbol.kind === "script" && symbol.name) {
      if (isAbsolute(symbol.name)) {
        candidates.push(symbol.name);
      } else {
        candidates.push(path.join(dir, symbol.name), path.join(project.root, symbol.name));
      }
    }
  }
  candidates.push(path.join(dir, "narration", "script.md"), path.join(project.assetsDir, "narration", "script.md"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { path: path.normalize(candidate), exists: true };
    }
  }
  return { path: path.normalize(candidates[0]), exists: false };
}

/** The script's lines, from its open document when there is one. */
export function readLines(file: string): string[] {
  const document = vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === "file" && doc.uri.fsPath === file);
  if (document) {
    return document.getText().split(/\r?\n/);
  }
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** The project's parsed script, when it exists. */
export function readScript(project: Project): { path: string; script: Script } | undefined {
  const where = scriptPath(project);
  if (!where.exists) {
    return undefined;
  }
  return { path: where.path, script: parseScript(readLines(where.path)) };
}

export function narrationDir(project: Project): string {
  return path.join(base(project), "narration");
}

/** The recorded take of a voiceover key, if there is one. */
export function takeFile(project: Project, key: string): string | undefined {
  const dir = narrationDir(project);
  return TAKE_EXTENSIONS.map((ext) => path.join(dir, `${key}.${ext}`)).find((file) => fs.existsSync(file));
}

/** The take's sidecar (`narration/<key>.json`): tapped marks and transcript words. */
export function readSidecar(project: Project, key: string): TakeSidecar {
  try {
    return JSON.parse(fs.readFileSync(path.join(narrationDir(project), `${key}.json`), "utf8")) as TakeSidecar;
  } catch {
    return {};
  }
}

/** Whether a path is the project's narration script. */
export function isScript(project: Project, file: string): boolean {
  const where = scriptPath(project);
  return path.normalize(file).toLowerCase() === where.path.toLowerCase();
}
