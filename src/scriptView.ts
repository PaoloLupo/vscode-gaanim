// The narration script beside the code.
//
// Opens `narration/script.md` at the side, keeps it on the section of the
// slide under the cursor (or of the slide the preview shows), jumps between a
// slide's code and its section both ways, adds missing sections with a mark
// per stop, and shows how long each section takes to say.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { talkClock } from "./core/clock";
import { findSection, HEADER, pace, parseScript, sectionAt, sectionInsert, spoken } from "./core/script";
import { pythonString, receiver, SceneSymbol, SLIDE_KINDS } from "./core/symbols";
import { openAt } from "./editorLink";
import { scriptChanged } from "./events";
import { scriptPath } from "./narration";
import {
  documentSymbols,
  fileSymbols,
  Project,
  projectForDocument,
  projectSymbols,
  requireProject,
  slideAtCursor,
} from "./project";

const paceTypes = {
  none: vscode.window.createTextEditorDecorationType({}),
  ok: vscode.window.createTextEditorDecorationType({}),
  tight: vscode.window.createTextEditorDecorationType({}),
  over: vscode.window.createTextEditorDecorationType({}),
};

const PACE_COLORS = {
  none: "gaanim.paceNone",
  ok: "gaanim.paceOk",
  tight: "gaanim.paceTight",
  over: "gaanim.paceOver",
};

function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/** The visible editor showing the project's script. */
function scriptEditor(project: Project): vscode.TextEditor | undefined {
  const where = scriptPath(project);
  return vscode.window.visibleTextEditors.find(
    (editor) => editor.document.uri.scheme === "file" && samePath(editor.document.uri.fsPath, where.path),
  );
}

/** Opens the script beside the code, creating it when missing. */
export async function open(project: Project, focus: boolean): Promise<vscode.TextEditor | undefined> {
  const where = scriptPath(project);
  if (!where.exists) {
    fs.mkdirSync(path.dirname(where.path), { recursive: true });
    fs.writeFileSync(where.path, [...HEADER, ""].join("\n"));
    vscode.window.setStatusBarMessage(`Created ${path.relative(project.root, where.path)}`, 4000);
  }
  const existing = scriptEditor(project);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(where.path));
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside,
    preserveFocus: !focus,
    preview: false,
  });
  scriptChanged.fire(project.root);
  return editor;
}

function reveal(editor: vscode.TextEditor, line: number, select = false): void {
  const position = new vscode.Position(Math.max(line - 1, 0), 0);
  const range = new vscode.Range(position, position);
  if (select) {
    editor.selection = new vscode.Selection(position, position);
  }
  editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
}

const followed = new Map<string, string>();

/** Scrolls an open script to the section of the slide under the cursor. */
export function followCursor(editor: vscode.TextEditor): void {
  if (!config.script.follow() || editor.document.languageId !== "python") {
    return;
  }
  const project = projectForDocument(editor.document);
  const target = project && scriptEditor(project);
  if (!project || !target) {
    return;
  }
  const here = slideAtCursor(editor);
  const name = here.segment?.name;
  const signature = `${name}:${here.stopIndex}`;
  if (!name || followed.get(editor.document.uri.toString()) === signature) {
    return;
  }
  followed.set(editor.document.uri.toString(), signature);
  const section = findSection(parseScript(target.document.getText().split(/\r?\n/)), name);
  if (section) {
    reveal(target, section.marks[here.stopIndex - 1]?.line ?? section.line);
  }
}

/** Scrolls an open script to the slide the preview shows: its stop's mark, else its section. */
export function showSlide(project: Project, segment: string, stop?: string): void {
  const target = scriptEditor(project);
  if (!target || !config.preview.followScript()) {
    return;
  }
  const section = findSection(parseScript(target.document.getText().split(/\r?\n/)), segment);
  if (!section) {
    return;
  }
  const mark = stop ? section.marks.find((candidate) => candidate.name.toLowerCase() === stop.toLowerCase()) : undefined;
  reveal(target, mark?.line ?? section.line);
}

/** Slide names in the order the code declares them, and each slide's stops. */
function slideOrder(project: Project): { order: string[]; stops: Map<string, string[]> } {
  const order: string[] = [];
  const stops = new Map<string, string[]>();
  let current: string | undefined;
  for (const symbol of projectSymbols(project)) {
    if (SLIDE_KINDS.has(symbol.kind) && symbol.name) {
      order.push(symbol.name);
      current = symbol.name;
      if (!stops.has(current)) {
        stops.set(current, []);
      }
    } else if (symbol.kind === "stop" && current) {
      stops.get(current)!.push(symbol.name ?? "");
    }
  }
  return { order, stops };
}

/** Adds a `## name` section with a mark per stop after the previous slide's; returns the heading line. */
async function addSection(project: Project, editor: vscode.TextEditor, name: string): Promise<number> {
  const lines = editor.document.getText().split(/\r?\n/);
  const { order, stops } = slideOrder(project);
  const insert = sectionInsert(lines, order, name, stops.get(name) ?? []);
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  await editor.edit((builder) => {
    if (insert.at >= lines.length) {
      const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
      const lead = lines[lines.length - 1] === "" ? "" : eol;
      builder.insert(end, lead + insert.lines.join(eol));
    } else {
      builder.insert(new vscode.Position(insert.at, 0), insert.lines.join(eol) + eol);
    }
  });
  return insert.heading;
}

/**
 * Jumps between a slide's code and its section: from the code to the section
 * (adding it when missing), from the script to the segment, or to the stop
 * of the mark under the cursor.
 */
export async function jump(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const project = editor ? projectForDocument(editor.document) : requireProject();
  if (!editor || !project) {
    void requireProject();
    return;
  }
  const where = scriptPath(project);
  if (samePath(editor.document.uri.fsPath, where.path)) {
    const line = editor.selection.active.line + 1;
    const script = parseScript(editor.document.getText().split(/\r?\n/));
    const section = sectionAt(script, line);
    if (!section) {
      void vscode.window.showWarningMessage("The cursor is in no section.");
      return;
    }
    const symbols = projectSymbols(project);
    const target =
      symbols.find((symbol) => SLIDE_KINDS.has(symbol.kind) && symbol.name === section.name) ??
      symbols.find((symbol) => symbol.name?.toLowerCase() === section.name.toLowerCase());
    if (!target) {
      const choice = await vscode.window.showWarningMessage(
        `No segment or voiceover named “${section.name}”.`,
        "Add It to the Code",
      );
      if (choice) {
        await scriptToCode([section.name]);
      }
      return;
    }
    // On a mark line: the matching stop after the segment.
    const markIndex = section.marks.filter((candidate) => candidate.line <= line).length;
    let destination: SceneSymbol = target;
    if (markIndex > 0) {
      let count = 0;
      for (const symbol of fileSymbols(target.file)) {
        if (symbol.line <= target.line) {
          continue;
        }
        if (SLIDE_KINDS.has(symbol.kind)) {
          break;
        }
        if (symbol.kind === "stop" && ++count === markIndex) {
          destination = symbol;
          break;
        }
      }
    }
    await openAt(destination.file, destination.line, destination.column);
    return;
  }
  if (editor.document.languageId !== "python") {
    await open(project, true);
    return;
  }
  const here = slideAtCursor(editor);
  if (!here.segment?.name) {
    void vscode.window.showWarningMessage("No segment or voiceover above the cursor.");
    return;
  }
  const scriptEditorNow = await open(project, true);
  if (!scriptEditorNow) {
    return;
  }
  const section = findSection(parseScript(scriptEditorNow.document.getText().split(/\r?\n/)), here.segment.name);
  if (section) {
    reveal(scriptEditorNow, section.marks[here.stopIndex - 1]?.line ?? section.line, true);
    return;
  }
  const heading = await addSection(project, scriptEditorNow, here.segment.name);
  vscode.window.setStatusBarMessage(`Added the section of ${here.segment.name}`, 3000);
  reveal(scriptEditorNow, heading);
  const body = new vscode.Position(Math.min(heading + 1, scriptEditorNow.document.lineCount - 1), 0);
  scriptEditorNow.selection = new vscode.Selection(body, body);
}

/** Opens the script at the side, keeping the focus on the code. */
export async function command(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  await open(project, false);
  followed.clear();
  if (vscode.window.activeTextEditor) {
    followCursor(vscode.window.activeTextEditor);
  }
}

/** Opens the script at the section of the slide or voiceover declared at a line. */
export async function openFor(file: string, line: number): Promise<void> {
  const editor = await openAt(file, line);
  if (editor) {
    await jump();
  }
}

/**
 * The reverse of `jump`: adds the slides that the script's `##` sections ask
 * for and the code lacks, a segment (slides) or a voiceover block (video)
 * with a stop per `[stop]` mark, before `scene.render()`.
 */
export async function scriptToCode(names?: string[]): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const where = scriptPath(project);
  if (!where.exists) {
    void vscode.window.showWarningMessage("The project has no narration script yet.");
    return;
  }
  const script = parseScript((await vscode.workspace.openTextDocument(where.path)).getText().split(/\r?\n/));
  const known = new Set(
    projectSymbols(project)
      .filter((symbol) => symbol.name)
      .map((symbol) => symbol.name!.toLowerCase()),
  );
  let missing = script.sections.filter((section) => !known.has(section.name.toLowerCase()));
  if (names) {
    missing = missing.filter((section) => names.includes(section.name));
  } else {
    if (missing.length === 0) {
      void vscode.window.showInformationMessage("Every section of the script has its slide in the code.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      missing.map((section) => ({ label: section.name, description: `${section.marks.length} stops`, picked: true, section })),
      { canPickMany: true, title: "Add to the code", placeHolder: "Sections of the script without a slide" },
    );
    if (!picked || picked.length === 0) {
      return;
    }
    missing = picked.map((item) => item.section);
  }
  if (missing.length === 0) {
    return;
  }
  const kind = project.kind === "video" ? "voiceover" : "segment";
  const active = vscode.window.activeTextEditor;
  const editor =
    active && active.document.languageId === "python" && projectForDocument(active.document)?.root === project.root
      ? active
      : await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(project.entry));
  const lines = editor.document.getText().split(/\r?\n/);
  const renderLine = lines.findIndex((line) => /^\s*[\w.]+\.render\(\s*\)/.test(line));
  const at = renderLine === -1 ? lines.length : renderLine;
  const scene = receiver(lines, at);
  const block: string[] = [];
  for (const section of missing) {
    if (kind === "segment") {
      block.push(`${scene}.segment(${pythonString(section.name)})`);
      for (const stop of section.marks) {
        block.push(`${scene}.stop(${stop.name ? pythonString(stop.name) : ""})`);
      }
      if (section.marks.length === 0) {
        block.push(`${scene}.stop()`);
      }
    } else {
      block.push(`with ${scene}.voiceover(${pythonString(section.name)}) as vo:`, "    pass");
    }
    block.push("");
  }
  const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  await editor.edit((builder) => {
    if (at >= lines.length) {
      const end = editor.document.lineAt(editor.document.lineCount - 1).range.end;
      builder.insert(end, eol + block.join(eol));
    } else {
      builder.insert(new vscode.Position(at, 0), block.join(eol) + eol);
    }
  });
  const position = new vscode.Position(at, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

/** Shows each section's spoken time against its slide's target, and the whole talk against the talk's. */
export function decorate(editor: vscode.TextEditor): void {
  const clear = () => {
    for (const type of Object.values(paceTypes)) {
      editor.setDecorations(type, []);
    }
  };
  if (editor.document.languageId !== "markdown" || editor.document.uri.scheme !== "file") {
    return;
  }
  const project = projectForDocument(editor.document);
  if (!project || !samePath(scriptPath(project).path, editor.document.uri.fsPath) || !config.script.timing()) {
    clear();
    return;
  }
  const script = parseScript(editor.document.getText().split(/\r?\n/));
  const targets = new Map<string, number>();
  let talk: number | undefined;
  for (const symbol of projectSymbols(project)) {
    if (symbol.name && symbol.target !== undefined && (symbol.kind === "segment" || symbol.kind === "section")) {
      targets.set(symbol.name.toLowerCase(), symbol.target);
    } else if (symbol.kind === "talk" && symbol.target !== undefined) {
      talk = symbol.target;
    }
  }
  const wpm = config.script.wpm();
  const groups: Record<keyof typeof paceTypes, vscode.DecorationOptions[]> = { none: [], ok: [], tight: [], over: [] };
  const add = (line: number, text: string, seconds: number, target?: number) => {
    const level = pace(seconds, target);
    groups[level].push({
      range: editor.document.lineAt(line - 1).range,
      renderOptions: {
        after: { contentText: text, color: new vscode.ThemeColor(PACE_COLORS[level]), margin: "0 0 0 1.5em" },
      },
    });
  };
  let total = 0;
  for (const section of script.sections) {
    const seconds = spoken(section.words, wpm);
    total += seconds;
    const target = targets.get(section.name.toLowerCase());
    add(section.line, `♪ ≈${talkClock(seconds)}${target !== undefined ? ` / ${talkClock(target)}` : ""}`, seconds, target);
  }
  if (script.title !== undefined) {
    add(script.title, `talk ≈${talkClock(total)}${talk !== undefined ? ` / ${talkClock(talk)}` : ""}`, total, talk);
  }
  for (const [level, type] of Object.entries(paceTypes) as [keyof typeof paceTypes, vscode.TextEditorDecorationType][]) {
    editor.setDecorations(type, groups[level]);
  }
}

/** The slide declared at a 1-based line of a document. */
export function slideDeclaredAt(document: vscode.TextDocument, line: number): SceneSymbol | undefined {
  return documentSymbols(document).find((symbol) => symbol.line === line && SLIDE_KINDS.has(symbol.kind) && symbol.name);
}

export function dispose(): void {
  for (const type of Object.values(paceTypes)) {
    type.dispose();
  }
}
