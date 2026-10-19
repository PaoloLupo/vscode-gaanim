// Finding projects, reading gaanim.toml, and the scene's symbols across files.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { parseSymbols, SceneSymbol, slideAt, SlideAt, SLIDE_KINDS } from "./core/symbols";
import { readTopLevel, TomlValue } from "./core/toml";
import * as workspace from "./workspace";

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

/**
 * The project of a folder holding gaanim.toml; undefined for a manifest that
 * names no project (a workspace's own, or one that only sets `assets_dir`).
 */
export function loadProject(root: string): Project | undefined {
  const manifest = path.join(root, "gaanim.toml");
  if (workspace.manifest(root)?.project === false) {
    return undefined;
  }
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

/**
 * The folder at or above `start` whose gaanim.toml names a project or a
 * workspace; a manifest that does neither is skipped, as Gaanim does.
 */
export function findRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const info = workspace.manifest(dir);
    if (info && (info.project || info.workspace)) {
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

function isGaanimScript(file: string, text?: string): boolean {
  if (!file.endsWith(".py")) {
    return false;
  }
  let source = text;
  if (source === undefined) {
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      return false;
    }
  }
  return importsGaanim(source);
}

/** The project a workspace's own files run as: its active member (or its only one). */
export function memberProject(root: string): Project | undefined {
  const member = workspace.activeMember(root);
  return member ? loadProject(member) : undefined;
}

/**
 * What a file in a workspace's own folders acts as: a script that imports
 * gaanim outside the shared Python folders is a project of its own (a
 * sketch); anything else, a shared module above all, runs as the active member.
 */
function inWorkspace(root: string, file: string, text?: string): Project | undefined {
  if (!workspace.isSharedFile(root, file) && isGaanimScript(file, text)) {
    return scriptProject(file);
  }
  return memberProject(root);
}

/**
 * The project of a file: the gaanim.toml above it, or the file itself when
 * it is a Python script that imports gaanim outside any project. In a
 * workspace's own folders, see `inWorkspace`.
 */
export function projectForFile(file: string, text?: string): Project | undefined {
  const dir = path.dirname(file);
  let root = rootCache.get(dir);
  if (root === undefined) {
    root = findRoot(dir) ?? null;
    rootCache.set(dir, root);
  }
  if (root) {
    const project = loadProject(root);
    if (project) {
      return project;
    }
    if (workspace.isRoot(root)) {
      return inWorkspace(root, file, text);
    }
  }
  return isGaanimScript(file, text) ? scriptProject(file) : undefined;
}

/** A Python file that imports gaanim, as a project of its own. */
function scriptProject(file: string): Project {
  const dir = path.dirname(file);
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
  if (editorWorkspace()) {
    // A workspace's own file with no member to run as yet.
    return undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    const project = loadProject(root) ?? (workspace.isRoot(root) ? memberProject(root) : undefined);
    if (project) {
      return project;
    }
  }
  return lastProject && exists(lastProject.root) ? lastProject : undefined;
}

/** The workspace whose own folders (a shared module, its manifest) hold a document. */
function ownWorkspace(document: vscode.TextDocument | undefined): string | undefined {
  if (document?.uri.scheme !== "file") {
    return undefined;
  }
  const root = findRoot(path.dirname(document.uri.fsPath));
  return root && workspace.isRoot(root) ? root : undefined;
}

/** The workspace whose own folders hold the active editor's file. */
function editorWorkspace(): string | undefined {
  return ownWorkspace(vscode.window.activeTextEditor?.document);
}

/**
 * The project of a document, for a command run on it. In a workspace's own
 * file with no member to run as yet, it asks which one (and the command runs
 * again); otherwise it tells `warning` when there is none.
 */
export function commandProject(document: vscode.TextDocument, warning?: string): Project | undefined {
  const project = projectForDocument(document);
  if (project) {
    return project;
  }
  const root = ownWorkspace(document);
  if (root) {
    void workspace.choose(root);
  } else if (warning) {
    void vscode.window.showWarningMessage(warning);
  }
  return undefined;
}

let lastProject: Project | undefined;

/** Remember the project last worked on, for views and commands run from them. */
export function rememberProject(project: Project | undefined): void {
  if (project) {
    lastProject = project;
  }
}

/**
 * Like `currentProject`, but tells the person when there is none. In a
 * workspace's own file with no active member yet, it takes the only member
 * or asks which one, and runs the command again with it.
 */
export function requireProject(): Project | undefined {
  const project = currentProject();
  if (project) {
    return project;
  }
  const root =
    editorWorkspace() ?? (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath).find((folder) => workspace.isRoot(folder));
  if (root) {
    void workspace.choose(root);
    return undefined;
  }
  void vscode.window.showWarningMessage("No Gaanim project here (no gaanim.toml above this file, and it does not import gaanim).");
  return undefined;
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

/** A workspace among the listed projects: it stands for its members. */
export interface WorkspaceListing {
  kind: "workspace";
  root: string;
  manifest: string;
  name: string;
  mtime: number;
}

export type Listed = (Project & { mtime: number }) | WorkspaceListing;

/** Projects and workspaces under `gaanim.projectsDir`, up to three levels deep, newest first. */
export function listProjects(): Listed[] {
  const dir = config.projectsDir();
  if (!dir) {
    return [];
  }
  const ignore = config.outline.ignore();
  const found: Listed[] = [];
  const walk = (folder: string, depth: number) => {
    if (workspace.isRoot(folder)) {
      // Its members are reached through it.
      const manifest = path.join(folder, "gaanim.toml");
      let mtime = 0;
      try {
        mtime = fs.statSync(manifest).mtimeMs;
      } catch {
        // Keep it, last.
      }
      found.push({ kind: "workspace", root: folder, manifest, name: workspace.manifest(folder)?.name ?? path.basename(folder), mtime });
      return;
    }
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

/** The Python interpreter in the `.venv` of a folder, if there is one. */
export function interpreter(root: string): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [".venv/Scripts/python.exe", "venv/Scripts/python.exe"]
      : [".venv/bin/python", "venv/bin/python"];
  return candidates.map((relative) => path.join(root, relative)).find(exists);
}

/** Without `gaanim project`: the project's own `.venv`, else its workspace's above it. */
export function fallbackInterpreter(project: Project): string | undefined {
  if (project.kind === "script") {
    return interpreter(project.root);
  }
  const above = workspace.rootAbove(path.dirname(project.root));
  return interpreter(project.root) ?? (above ? interpreter(above) : undefined);
}
