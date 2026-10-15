// Where the preview rests, and what animates, marked in the code.

import * as vscode from "vscode";
import { config } from "./config";
import { clock } from "./core/clock";
import { location, pathKey, playsAt } from "./core/timeline";
import * as inspect from "./inspect";
import { projectSymbols, Project } from "./project";
import { Playhead, status } from "./preview";

const playheadType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("gaanim.playheadBackground"),
  overviewRulerColor: new vscode.ThemeColor("gaanim.playheadForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Center,
});

const animatingType = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("gaanim.animatingBackground"),
});

/** Where the code says the preview rests: the stop's line, else its segment's. */
export function playheadLocation(project: Project, playhead: Playhead): { file: string; line: number } | undefined {
  const data = inspect.cached(project);
  const stop = playhead.stop ? playhead.stop : undefined;
  if (data) {
    const found = (stop !== undefined && location(data, playhead.segment, stop)) || location(data, playhead.segment);
    if (found) {
      return found;
    }
  }
  const symbols = projectSymbols(project);
  if (stop) {
    const symbol = symbols.find((candidate) => candidate.kind === "stop" && candidate.name === stop);
    if (symbol) {
      return { file: symbol.file, line: symbol.line };
    }
  }
  const segment = playhead.segment && symbols.find((candidate) => candidate.name === playhead.segment && candidate.kind !== "stop");
  return segment ? { file: segment.file, line: segment.line } : undefined;
}

function playheadText(playhead: Playhead): string {
  const what = playhead.loop ? "⟲ loop" : playhead.playing ? "▶ preview" : "⏸ preview";
  return `  ◀ ${what} ${clock(playhead.time)}`;
}

/** Refreshes the marks in every visible editor of a project. */
export function refresh(root: string): void {
  const preview = status.get(root);
  const playhead = preview?.playhead;
  const project = preview?.project;
  const at = project && playhead && config.preview.marker() ? playheadLocation(project, playhead) : undefined;
  const data = project && inspect.cached(project);
  const animating =
    playhead?.playing && data && config.preview.animating() ? playsAt(data, playhead.time) : [];
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== "file" || editor.document.languageId !== "python") {
      continue;
    }
    const file = pathKey(editor.document.uri.fsPath);
    if (!file.startsWith(pathKey(root)) && !(project && pathKey(project.target) === file)) {
      continue;
    }
    const lines = editor.document.lineCount;
    const range = (line: number) => editor.document.lineAt(Math.min(line, lines) - 1).range;
    editor.setDecorations(
      playheadType,
      at && playhead && pathKey(at.file) === file
        ? [
            {
              range: range(at.line),
              renderOptions: {
                after: { contentText: playheadText(playhead), color: new vscode.ThemeColor("gaanim.playheadForeground") },
              },
            },
          ]
        : [],
    );
    // A file with unsaved edits has moved lines: only the saved one is marked.
    editor.setDecorations(
      animatingType,
      editor.document.isDirty ? [] : animating.filter((play) => pathKey(play.file) === file).map((play) => range(play.line)),
    );
  }
}

export function dispose(): void {
  playheadType.dispose();
  animatingType.dispose();
}
