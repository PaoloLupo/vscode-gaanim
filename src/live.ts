// Live mode: the preview follows your edits as you make them.
//
// A changed project file is saved shortly after you stop typing, without
// formatters (`Save without Formatting`). Gaanim reloads on every save, so
// the preview shows each change within a fraction of a second.

import * as vscode from "vscode";
import { config } from "./config";
import { previewChanged } from "./events";
import * as preview from "./preview";
import { projectForDocument, requireProject } from "./project";

/** Projects in live mode. */
export const enabled = new Set<string>();

/** Documents being saved by live mode, so a save does not also run a check. */
export const saving = new Set<string>();

const timers = new Map<string, NodeJS.Timeout>();

preview.setLiveCheck((root) => enabled.has(root));

export function active(root: string): boolean {
  return enabled.has(root);
}

/** Turns live mode on or off for the current project; on opens the preview at the cursor when it is closed. */
export async function toggle(on?: boolean): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const enable = on ?? !enabled.has(project.root);
  if (enable) {
    enabled.add(project.root);
    if (!preview.status.get(project.root)) {
      await preview.here();
    }
    vscode.window.setStatusBarMessage("Live: changes reach the preview as you make them", 3000);
  } else {
    enabled.delete(project.root);
    vscode.window.setStatusBarMessage("Live mode off", 3000);
  }
  previewChanged.fire(project.root);
}

async function save(document: vscode.TextDocument): Promise<void> {
  if (document.isClosed || !document.isDirty) {
    return;
  }
  const key = document.uri.toString();
  saving.add(key);
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) {
      await vscode.commands.executeCommand("workbench.action.files.saveWithoutFormatting");
    } else {
      await document.save();
    }
  } finally {
    setTimeout(() => saving.delete(key), 50);
  }
}

/** When a document changes: saves it once the changes settle, in a project in live mode. */
export function onChange(event: vscode.TextDocumentChangeEvent): void {
  if (enabled.size === 0 || event.contentChanges.length === 0 || event.document.uri.scheme !== "file") {
    return;
  }
  const document = event.document;
  if (!/\.(py|md|toml)$/.test(document.fileName)) {
    return;
  }
  const project = projectForDocument(document);
  if (!project || !enabled.has(project.root)) {
    return;
  }
  const key = document.uri.toString();
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void save(document);
    }, config.live.delay()),
  );
}
