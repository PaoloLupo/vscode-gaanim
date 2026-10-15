// The documentation of the installed Gaanim.
//
// The authoring wheel bundles the docs' Typst sources as `gaanim/_docs` in
// the project's environment, so they match the Gaanim the project runs. API
// entries read `#api-entry(name: "Scene.voiceover", ...)`.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { openAt } from "./editorLink";
import { currentProject } from "./project";

/** The `_docs` folder for the current project, or from `GAANIM_DOCS`. */
export function docsDir(): string | undefined {
  const env = process.env.GAANIM_DOCS;
  if (env && fs.existsSync(env)) {
    return env;
  }
  const project = currentProject();
  let dir = project?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  while (dir) {
    for (const venv of [".venv", "venv"]) {
      const root = path.join(dir, venv);
      if (!fs.existsSync(root)) {
        continue;
      }
      const candidates = [path.join(root, "Lib", "site-packages", "gaanim", "_docs")];
      try {
        for (const version of fs.readdirSync(path.join(root, "lib"))) {
          candidates.push(path.join(root, "lib", version, "site-packages", "gaanim", "_docs"));
        }
      } catch {
        // Windows layout only.
      }
      const found = candidates.find((candidate) => fs.existsSync(candidate));
      if (found) {
        return found;
      }
    }
    const parent = path.dirname(dir);
    dir = parent === dir ? undefined : parent;
  }
  return undefined;
}

function requireDocs(): string | undefined {
  const dir = docsDir();
  if (!dir) {
    void vscode.window.showWarningMessage(
      "No bundled docs found: open the project once with gaanim (it creates the .venv), or set GAANIM_DOCS.",
      "Open Online Docs",
    ).then((choice) => {
      if (choice) {
        void vscode.env.openExternal(vscode.Uri.parse("https://paololupo.github.io/gaanim/"));
      }
    });
  }
  return dir;
}

function typFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (folder: string, depth: number) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() && depth < 4) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith(".typ")) {
        out.push(full);
      }
    }
  };
  walk(dir, 0);
  return out;
}

interface ApiEntry {
  name: string;
  file: string;
  line: number;
}

let entryCache: { dir: string; entries: ApiEntry[] } | undefined;

/** Every `#api-entry(name: ...)` in the docs. */
export function apiEntries(dir: string): ApiEntry[] {
  if (entryCache?.dir === dir) {
    return entryCache.entries;
  }
  const entries: ApiEntry[] = [];
  for (const file of typFiles(dir)) {
    let inEntry = false;
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        // `#api-entry(` and its `name: "..."` share a line or follow each other.
        const name = /api-entry\(\s*name:\s*"([^"]+)"/.exec(line)?.[1] ?? (inEntry ? /^\s*name:\s*"([^"]+)"/.exec(line)?.[1] : undefined);
        inEntry = /api-entry\(\s*$/.test(line);
        if (name) {
          entries.push({ name, file, line: index + 1 });
        }
      });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entryCache = { dir, entries };
  return entries;
}

function grep(dir: string, query: string): { file: string; line: number; text: string }[] {
  const wanted = query.toLowerCase();
  const hits: { file: string; line: number; text: string }[] = [];
  for (const file of typFiles(dir)) {
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((text, index) => {
        if (hits.length < 300 && text.toLowerCase().includes(wanted)) {
          hits.push({ file, line: index + 1, text: text.trim() });
        }
      });
  }
  return hits;
}

/** Searches the docs: API entries as you type, and every line with the text on Enter. */
export async function search(initial?: string): Promise<void> {
  const dir = requireDocs();
  if (!dir) {
    return;
  }
  type Item = vscode.QuickPickItem & { file?: string; line?: number; query?: string };
  const entries = apiEntries(dir);
  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.title = "Gaanim docs";
  quickPick.placeholder = "An API name, or any text and Enter to search every page";
  quickPick.matchOnDescription = true;
  const update = () => {
    const text = quickPick.value.trim();
    const items: Item[] = entries.map((entry) => ({
      label: `$(symbol-method) ${entry.name}`,
      description: `${path.relative(dir, entry.file)}:${entry.line}`,
      file: entry.file,
      line: entry.line,
    }));
    if (text) {
      items.unshift({ label: `$(search) Search the docs for “${text}”`, query: text, alwaysShow: true });
    } else {
      items.unshift({ label: "$(book) Index", file: path.join(dir, "index.typ"), line: 1, alwaysShow: true });
    }
    quickPick.items = items;
  };
  quickPick.onDidChangeValue(update);
  quickPick.value = initial ?? "";
  update();
  quickPick.onDidAccept(async () => {
    const item = quickPick.selectedItems[0];
    quickPick.hide();
    if (item?.file) {
      await openAt(item.file, item.line ?? 1);
    } else if (item?.query) {
      const hits = grep(dir, item.query);
      if (hits.length === 0) {
        void vscode.window.showInformationMessage(`Nothing in the docs mentions “${item.query}”.`);
        return;
      }
      const hit = await vscode.window.showQuickPick(
        hits.map((found) => ({ label: found.text.slice(0, 120), description: `${path.relative(dir, found.file)}:${found.line}`, found })),
        { title: `Docs · ${item.query}`, matchOnDescription: true },
      );
      if (hit) {
        await openAt(hit.found.file, hit.found.line);
      }
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

/** Opens the API entry of a name (`voiceover` finds `Scene.voiceover`), by default the word at the cursor. */
export async function api(name?: string): Promise<void> {
  const dir = requireDocs();
  if (!dir) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  let word = name;
  if (!word && editor) {
    const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][\w]*/);
    word = range ? editor.document.getText(range) : undefined;
  }
  if (!word) {
    await search();
    return;
  }
  const wanted = word.toLowerCase();
  const matches = apiEntries(dir).filter((entry) => {
    const lower = entry.name.toLowerCase();
    return lower === wanted || lower.endsWith(`.${wanted}`) || lower.split(/\s*\/\s*/).some((part) => part === wanted);
  });
  if (matches.length === 0) {
    await search(word);
  } else if (matches.length === 1) {
    await openAt(matches[0].file, matches[0].line);
  } else {
    const picked = await vscode.window.showQuickPick(
      matches.map((entry) => ({ label: entry.name, description: `${path.relative(dir, entry.file)}:${entry.line}`, entry })),
      { title: `Gaanim API · ${word}` },
    );
    if (picked) {
      await openAt(picked.entry.file, picked.entry.line);
    }
  }
}
