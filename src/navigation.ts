// Jumping to slides, stops and markers: the quick outline from the Python, and the real timeline.

import * as path from "node:path";
import * as vscode from "vscode";
import { clock, talkClock } from "./core/clock";
import { STRUCTURE } from "./core/symbols";
import { entries, TimelineEntry } from "./core/timeline";
import { openAt } from "./editorLink";
import * as inspect from "./inspect";
import { Command, send } from "./preview";
import { Project, projectSymbols, requireProject } from "./project";
import * as cli from "./cli";

const ICONS: Record<string, string> = {
  segment: "$(preview)",
  section: "$(symbol-namespace)",
  stop: "$(debug-pause)",
  marker: "$(bookmark)",
  voiceover: "$(mic)",
};

type Item = vscode.QuickPickItem & { file?: string; line?: number; column?: number; seek?: Command };

async function pick(project: Project, title: string, items: Item[]): Promise<void> {
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  if (!picked) {
    return;
  }
  if (picked.file && picked.line) {
    await openAt(picked.file, picked.line, picked.column);
  }
  // A preview that takes commands goes there too.
  if (picked.seek) {
    send(project, picked.seek);
  }
}

/** The project's structure as the Python writes it. */
export async function outline(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const items: Item[] = projectSymbols(project)
    .filter((symbol) => STRUCTURE.has(symbol.kind))
    .map((symbol) => {
      const indent = symbol.kind === "stop" || symbol.kind === "marker" ? "    " : "";
      const name = (symbol.name ?? "(unnamed)") + (symbol.title ? ` · ${symbol.title}` : "");
      const target = symbol.target !== undefined ? `  target ${talkClock(symbol.target)}` : "";
      return {
        label: `${indent}${ICONS[symbol.kind]} ${name}`,
        description: `${path.relative(project.root, symbol.file)}:${symbol.line}${target}`,
        file: symbol.file,
        line: symbol.line,
        column: symbol.column,
        seek:
          symbol.kind === "stop" && symbol.name
            ? { cmd: "seek", stop: symbol.name }
            : (symbol.kind === "segment" || symbol.kind === "section") && symbol.name
              ? { cmd: "seek", segment: symbol.name }
              : undefined,
      };
    });
  await pick(project, `Gaanim · ${project.name}`, items);
}

function entryItem(project: Project, entry: TimelineEntry): Item {
  const indent = entry.kind === "segment" || entry.kind === "section" ? "" : "    ";
  const time = entry.end !== undefined && entry.kind !== "stop" ? `${clock(entry.time)}–${clock(entry.end)}` : clock(entry.time);
  const where = entry.file && entry.line ? `  ${path.relative(project.root, entry.file)}:${entry.line}` : "";
  return {
    label: `${indent}${ICONS[entry.kind]} ${entry.label}`,
    description: `${time}${where}`,
    file: entry.file,
    line: entry.line,
    seek: entry.seek,
  };
}

/** The timeline the scene really made, with times: jump to a line and move the preview there. */
export async function timeline(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  if (!(await cli.caps()).inspect && !inspect.cached(project)) {
    void vscode.window.showWarningMessage("The timeline needs a Gaanim with inspect; showing the outline.");
    await outline();
    return;
  }
  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Gaanim: reading the timeline" },
    () => inspect.get(project),
  );
  if (!data) {
    void vscode.window.showErrorMessage("gaanim inspect failed; see the Gaanim log.");
    return;
  }
  await pick(
    project,
    `Timeline · ${project.name} · ${clock(data.duration)}`,
    entries(data).map((entry) => entryItem(project, entry)),
  );
}
