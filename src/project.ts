// Finding projects, reading gaanim.toml, and the scene's symbols across files.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { parseSymbols, SceneSymbol, slideAt, SlideAt, SLIDE_KINDS } from "./core/symbols";
import { readTopLevel, TomlValue } from "./core/toml";

export interface Project {
  /** Project folder, or the script's folder for a lone script. */
  root: string;
  /** What the CLI receives: the folder, or the lone script. */
  target: string;
  manifest?: string;
  name: string;
  kind: "video" | "slides" | "script";
  /** Entry script, absolute. */
  entry: string;
  assetsDir: string;
  outputDir: string;
  language?: string;
  raw: Record<string, TomlValue>;
}

function exists(file: string): boolean {
  return fs.existsSync(file);
}

/** The project of a folder holding gaanim.toml. */
export function loadProject(root: string): Project | undefined {
  const manifest = path.join(root, "gaanim.toml");
  let text: string;
  try {
    text = fs.readFileSync(manifest, "utf8");
  } catch {
    return undefined;
  }
  const raw = readTopLevel(text);
  const str = (key: string, fallback: string) => (typeof raw[key] === "string" ? (raw[key] as string) : fallback);
  return {
    root,
    target: root,
    manifest,
    name: str("name", path.basename(root)),
    kind: raw.kind === "slides" ? "slides" : "video",
    entry: path.join(root, str("entry", "main.py")),
    assetsDir: path.join(root, str("assets_dir", "assets")),
    outputDir: path.join(root, str("output_dir", "exports")),
    language: typeof raw.language === "string" ? raw.language : undefined,
    raw,
  };
}

/** The folder holding gaanim.toml at or above `start`. */
export function findRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (exists(path.join(dir, "gaanim.toml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function importsGaanim(text: string): boolean {
  return /(^|\n)\s*(from\s+gaanim\b|import\s+gaanim\b)/.test(text.slice(0, 4096));
}

const rootCache = new Map<string, string | null>();

/** Forget where files' projects are, after a gaanim.toml appears or goes. */
export function forgetRoots(): void {
  rootCache.clear();
}

/**
 * The project of a file: the gaanim.toml above it, or the file itself when
 * it is a Python script that imports gaanim outside any project.
 */
export function projectForFile(file: string, text?: string): Project | undefined {
  const dir = path.dirname(file);
  let root = rootCache.get(dir);
  if (root === undefined) {
    root = findRoot(dir) ?? null;
    rootCache.set(dir, root);
  }
  if (root) {
    return loadProject(root);
  }
  if (!file.endsWith(".py")) {
    return undefined;
  }
  let source = text;
  if (source === undefined) {
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }
  if (!importsGaanim(source)) {
    return undefined;
  }
  return {
    root: dir,
    target: file,
    name: path.basename(file, ".py"),
    kind: "script",
    entry: file,
    assetsDir: path.join(dir, "assets"),
    outputDir: dir,
    raw: {},
  };
}

export function projectForDocument(document: vscode.TextDocument): Project | undefined {
  if (document.uri.scheme !== "file") {
    return undefined;
  }
  return projectForFile(document.uri.fsPath, document.languageId === "python" ? document.getText() : undefined);
}

/** The project of the active editor, else of the first workspace folder that is one. */
export function currentProject(): Project | undefined {
  const editor = vscode.window.activeTextEditor;
  const fromEditor = editor && projectForDocument(editor.document);
  if (fromEditor) {
    return fromEditor;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const project = loadProject(folder.uri.fsPath);
    if (project) {
      return project;
    }
  }
  return lastProject && exists(lastProject.root) ? lastProject : undefined;
}

let lastProject: Project | undefined;

/** Remember the project last worked on, for views and commands run from them. */
export function rememberProject(project: Project | undefined): void {
  if (project) {
    lastProject = project;
  }
}

/** Like `currentProject`, but tells the person when there is none. */
export function requireProject(): Project | undefined {
  const project = currentProject();
  if (!project) {
    void vscode.window.showWarningMessage("No Gaanim project here (no gaanim.toml above this file, and it does not import gaanim).");
  }
  return project;
}

/** Python files of a project, the entry script first, skipping environments and outputs. */
export function pythonFiles(project: Project): string[] {
  if (project.kind === "script") {
    return [project.entry];
  }
  const ignore = config.outline.ignore();
  const files: string[] = [];
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
        if (depth < 6 && !ignore.has(entry.name) && !entry.name.startsWith(".")) {
          walk(full, depth + 1);
        }
      } else if (entry.name.endsWith(".py")) {
        files.push(full);
      }
    }
  };
  walk(project.root, 1);
  files.sort((a, b) => (a === project.entry ? -1 : b === project.entry ? 1 : a.localeCompare(b)));
  return files;
}

const fileCache = new Map<string, { mtime: number; size: number; symbols: SceneSymbol[] }>();
const documentCache = new WeakMap<vscode.TextDocument, { version: number; symbols: SceneSymbol[] }>();

function openDocument(file: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file);
}

/** Symbols of a document as it is now, parsed again only after it changes. */
export function documentSymbols(document: vscode.TextDocument): SceneSymbol[] {
  const cached = documentCache.get(document);
  if (cached && cached.version === document.version) {
    return cached.symbols;
  }
  const symbols = parseSymbols(document.getText(), document.uri.fsPath, config.outline.patterns());
  documentCache.set(document, { version: document.version, symbols });
  return symbols;
}

/** Symbols of a file, from its open document when it has unsaved edits. */
export function fileSymbols(file: string): SceneSymbol[] {
  const document = openDocument(file);
  if (document?.isDirty) {
    return documentSymbols(document);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    return cached.symbols;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const symbols = parseSymbols(text, file, config.outline.patterns());
  fileCache.set(file, { mtime: stat.mtimeMs, size: stat.size, symbols });
  return symbols;
}

/** Every symbol of a project, file by file. */
export function projectSymbols(project: Project): SceneSymbol[] {
  return pythonFiles(project).flatMap(fileSymbols);
}

/** Forget parsed files, after settings change. */
export function forgetSymbols(): void {
  fileCache.clear();
}

/** Where a segment, section or voiceover named `name` is declared. */
export function findSymbol(project: Project, name: string, kinds: ReadonlySet<string> = SLIDE_KINDS): SceneSymbol | undefined {
  return projectSymbols(project).find((symbol) => kinds.has(symbol.kind) && symbol.name === name);
}

/** The slide around the cursor of an editor. */
export function slideAtCursor(editor: vscode.TextEditor): SlideAt {
  return slideAt(documentSymbols(editor.document), editor.selection.active.line + 1);
}

/** Projects under `gaanim.projectsDir`, up to three levels deep, newest first. */
export function listProjects(): (Project & { mtime: number })[] {
  const dir = config.projectsDir();
  if (!dir) {
    return [];
  }
  const ignore = config.outline.ignore();
  const found: (Project & { mtime: number })[] = [];
  const walk = (folder: string, depth: number) => {
    const project = loadProject(folder);
    if (project) {
      let mtime = 0;
      try {
        mtime = fs.statSync(exists(project.entry) ? project.entry : project.manifest!).mtimeMs;
      } catch {
        // Keep it, last.
      }
      found.push({ ...project, mtime });
      return;
    }
    if (depth >= 3) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !ignore.has(entry.name) && entry.name !== "assets") {
        walk(path.join(folder, entry.name), depth + 1);
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** The project's Python interpreter in its `.venv`, if there is one. */
export function interpreter(root: string): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [".venv/Scripts/python.exe", "venv/Scripts/python.exe"]
      : [".venv/bin/python", "venv/bin/python"];
  return candidates.map((relative) => path.join(root, relative)).find(exists);
}
