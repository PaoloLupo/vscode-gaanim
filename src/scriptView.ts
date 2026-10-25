// The narration script beside the code.
//
// Opens `narration/script.md` at the side, keeps it on the text said where
// the cursor (or the preview) rests, jumps between a slide's code and its
// section both ways, moves the preview to a section or mark, adds missing
// sections with a mark per stop, and shows how long each section takes to say.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { talkClock } from "./core/clock";
import {
  chunkAt,
  chunkLines,
  findSection,
  HEADER,
  pace,
  parseScript,
  ScriptSection,
  sectionAt,
  sectionInsert,
  spoken,
} from "./core/script";
import { pythonString, receiver, SceneSymbol, SlideAt, SLIDE_KINDS } from "./core/symbols";
import { chunkAtTime, chunkSeek, segmentNamed } from "./core/timeline";
import { openAt } from "./editorLink";
import { scriptChanged, timelineChanged } from "./events";
import * as inspect from "./inspect";
import { isScript, scriptPath } from "./narration";
import * as preview from "./preview";
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

function reveal(editor: vscode.TextEditor, line: number): void {
  const position = new vscode.Position(Math.max(line - 1, 0), 0);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
}

/** Shows a chunk of a section: at the top for another slide, else with as little scrolling as it takes. */
function showChunk(editor: vscode.TextEditor, section: ScriptSection, chunk: number, top: boolean): void {
  const { start, end } = chunkLines(section, chunk);
  if (top) {
    reveal(editor, start);
  } else {
    editor.revealRange(new vscode.Range(start - 1, 0, end - 1, 0), vscode.TextEditorRevealType.Default);
  }
}

/** The chunk said where the cursor's line of code rests: on a stop, the text before its mark. */
function cursorChunk(editor: vscode.TextEditor, here: SlideAt): number {
  return here.stopIndex - (here.stop?.line === editor.selection.active.line + 1 ? 1 : 0);
}

const followed = new Map<string, { segment: string; chunk: number }>();

/** Scrolls an open script to the text said where the line under the cursor rests. */
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
  if (!name) {
    return;
  }
  const chunk = cursorChunk(editor, here);
  const key = editor.document.uri.toString();
  const last = followed.get(key);
  if (last?.segment === name && last.chunk === chunk) {
    return;
  }
  followed.set(key, { segment: name, chunk });
  const section = findSection(parseScript(target.document.getText().split(/\r?\n/)), name);
  if (section) {
    showChunk(target, section, chunk, last?.segment !== name);
  }
}

const shown = new Map<string, { segment: string; chunk?: number }>();

/**
 * Keeps an open script on the slide the preview shows. Another slide brings
 * its section to the top; within a slide the script only moves where the
 * preview rests, to the text said there. The preview plays through stops,
 * and the text before a mark goes on being said after its stop.
 */
export function showPlayhead(project: Project, playhead: preview.Playhead): void {
  const name = playhead.segment;
  if (!name) {
    return;
  }
  let chunk: number | undefined;
  if (!playhead.playing) {
    const data = inspect.cached(project);
    const segment = data && segmentNamed(data, name, playhead.time);
    // Without the stops' times, only resting before the first stop is known.
    chunk = segment ? chunkAtTime(segment, playhead.time) : playhead.stop === undefined ? 0 : undefined;
  }
  const last = shown.get(project.root);
  shown.set(project.root, { segment: name, chunk });
  const another = last?.segment !== name;
  if (!another && (chunk === undefined || chunk === last?.chunk)) {
    return;
  }
  const target = scriptEditor(project);
  if (!target || !config.preview.followScript()) {
    return;
  }
  const section = findSection(parseScript(target.document.getText().split(/\r?\n/)), name);
  if (section) {
    showChunk(target, section, chunk ?? 0, another);
  }
}

/** Forgets where a closed preview rested. */
export function forgetPlayhead(root: string): void {
  shown.delete(root);
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
      await offerToAdd(section.name);
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
  const chunk = cursorChunk(editor, here);
  const scriptEditorNow = await open(project, true);
  if (!scriptEditorNow) {
    return;
  }
  const section = findSection(parseScript(scriptEditorNow.document.getText().split(/\r?\n/)), here.segment.name);
  if (section) {
    // The text said there in view, the cursor on the mark of the stop at or above the line.
    showChunk(scriptEditorNow, section, chunk, true);
    const at = new vscode.Position((section.marks[here.stopIndex - 1]?.line ?? section.line) - 1, 0);
    scriptEditorNow.selection = new vscode.Selection(at, at);
    scriptEditorNow.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.Default);
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

async function offerToAdd(name: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(`No segment or voiceover named “${name}”.`, "Add It to the Code");
  if (choice) {
    await scriptToCode([name]);
  }
}

/** Whether a document is its project's narration script. */
export function isScriptDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== "file" || document.languageId !== "markdown") {
    return false;
  }
  const project = projectForDocument(document);
  return Boolean(project && isScript(project, document.uri.fsPath));
}

/** The names of the project's slides and voiceovers (lowercase), from the timeline and the code, and which they are. */
function scriptTargets(project: Project): Map<string, "slide" | "voiceover"> {
  const targets = new Map<string, "slide" | "voiceover">();
  const data = inspect.cached(project);
  for (const segment of data?.segments ?? []) {
    targets.set(segment.name.toLowerCase(), "slide");
  }
  for (const voiceover of data?.voiceovers ?? []) {
    if (!targets.has(voiceover.key.toLowerCase())) {
      targets.set(voiceover.key.toLowerCase(), "voiceover");
    }
  }
  for (const symbol of projectSymbols(project)) {
    if (symbol.name && SLIDE_KINDS.has(symbol.kind) && !targets.has(symbol.name.toLowerCase())) {
      targets.set(symbol.name.toLowerCase(), symbol.kind === "voiceover" ? "voiceover" : "slide");
    }
  }
  return targets;
}

/**
 * Moves the preview to where a line of the script is said: a heading to its
 * slide, and text or a mark to the stop the slide waits at while it is said
 * (the text after the last mark, to the end of the slide). A voiceover's
 * section goes to its start.
 */
export async function previewLine(document: vscode.TextDocument, line: number): Promise<void> {
  const project = projectForDocument(document);
  if (!project) {
    void requireProject();
    return;
  }
  const section = sectionAt(parseScript(document.getText().split(/\r?\n/)), line);
  if (!section) {
    void vscode.window.showWarningMessage("The cursor is in no section.");
    return;
  }
  const chunk = chunkAt(section, line);
  const data = inspect.cached(project) ?? (await inspect.get(project));
  const segment = data && segmentNamed(data, section.name);
  const voiceover = data?.voiceovers?.find((candidate) => candidate.key.toLowerCase() === section.name.toLowerCase());
  if (segment) {
    await preview.seekTo(chunkSeek(segment, chunk), project);
  } else if (voiceover) {
    await preview.seekTo({ time: voiceover.start }, project);
  } else if (scriptTargets(project).get(section.name.toLowerCase()) === "slide") {
    // Not in the timeline yet: by name.
    const mark = section.marks[chunk];
    await preview.seekTo(mark?.name ? { segment: section.name, stop: mark.name } : { segment: section.name }, project);
  } else {
    await offerToAdd(section.name);
  }
}

/** Lenses over the script's headings and marks: move the preview there, or go to their code. */
export class ScriptLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor() {
    timelineChanged.event(() => this.changed.fire());
    scriptChanged.event(() => this.changed.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const project = config.codeLens() ? projectForDocument(document) : undefined;
    if (!project || !isScript(project, document.uri.fsPath)) {
      return [];
    }
    const targets = scriptTargets(project);
    const uri = document.uri;
    const lenses: vscode.CodeLens[] = [];
    const lens = (line: number, title: string, command: string, args: unknown[], tooltip: string) =>
      lenses.push(new vscode.CodeLens(new vscode.Range(line - 1, 0, line - 1, 0), { title, command, arguments: args, tooltip }));
    for (const section of parseScript(document.getText().split(/\r?\n/)).sections) {
      const kind = targets.get(section.name.toLowerCase());
      if (!kind) {
        lens(section.line, "$(add) Add to the code", "gaanim.scriptLens.add", [section.name], "Write its slide before scene.render()");
        continue;
      }
      lens(section.line, "$(play) Preview", "gaanim.scriptLens.preview", [uri, section.line], `Move the preview to ${section.name}`);
      lens(section.line, "$(go-to-file) Code", "gaanim.scriptLens.code", [uri, section.line], "Go to its code");
      if (kind === "voiceover") {
        continue;
      }
      for (const mark of section.marks) {
        const which = mark.name ? `the stop ${mark.name}` : "this stop";
        lens(mark.line, "$(play) Preview", "gaanim.scriptLens.preview", [uri, mark.line], `Move the preview to ${which}`);
        lens(mark.line, "$(go-to-file) Code", "gaanim.scriptLens.code", [uri, mark.line], `Go to ${which} in the code`);
      }
    }
    return lenses;
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
