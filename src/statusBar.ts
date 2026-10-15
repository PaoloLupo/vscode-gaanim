// The preview's state and the cursor's instant in the status bar.

import * as vscode from "vscode";
import { clock } from "./core/clock";
import { pointAt } from "./core/timeline";
import * as inspect from "./inspect";
import * as live from "./live";
import { following, status } from "./preview";
import { currentProject, projectForDocument } from "./project";

const previewItem = vscode.window.createStatusBarItem("gaanim.preview", vscode.StatusBarAlignment.Left, 50);
previewItem.name = "Gaanim Preview";
const cursorItem = vscode.window.createStatusBarItem("gaanim.cursor", vscode.StatusBarAlignment.Right, 200);
cursorItem.name = "Gaanim Instant at Cursor";
cursorItem.command = "gaanim.previewHere";

/** Shows the state of the current project's preview. */
export function refreshPreview(): void {
  const project = currentProject();
  const preview = project && status.get(project.root);
  if (!project || !preview) {
    if (project && live.active(project.root)) {
      previewItem.text = "$(zap) live";
      previewItem.tooltip = "Live mode is on; the preview is closed";
      previewItem.command = "gaanim.previewHere";
      previewItem.show();
    } else {
      previewItem.hide();
    }
    return;
  }
  const flags = [following.has(project.root) ? "$(link)" : "", live.active(project.root) ? "$(zap)" : ""].filter(Boolean).join(" ");
  const playhead = preview.playhead;
  let text: string;
  let tooltip: string;
  switch (preview.state) {
    case "starting":
      text = "$(loading~spin) starting";
      tooltip = `Starting the ${preview.present ? "presentation" : "preview"} of ${project.name}`;
      break;
    case "reloading":
      text = "$(sync~spin) reloading";
      tooltip = `Reloading ${project.name}`;
      break;
    case "failed":
      text = "$(error) failed";
      tooltip = preview.detail ?? "The script failed";
      break;
    default:
      if (playhead) {
        const icon = playhead.loop ? "$(sync)" : playhead.playing ? "$(play)" : "$(debug-pause)";
        const where = [playhead.segment, playhead.stop].filter(Boolean).join("·");
        text = `${icon} ${clock(playhead.time)}${where ? ` ${where}` : ""}`;
        tooltip = `${project.name}: ${playhead.playing ? "playing" : "paused"}${playhead.loop ? `, looping ${clock(playhead.loop[0])}–${clock(playhead.loop[1])}` : ""}. Click to ${playhead.playing ? "pause" : "play"}.`;
      } else {
        text = `$(preview) ${preview.detail ?? "ready"}`;
        tooltip = `${project.name} is ${preview.present ? "presenting" : "in the preview"}`;
      }
  }
  previewItem.text = `${flags ? `${flags} ` : ""}${text}`;
  previewItem.tooltip = tooltip;
  previewItem.command = preview.state === "failed" ? "workbench.actions.view.problems" : preview.listen ? "gaanim.togglePlay" : "gaanim.stop";
  previewItem.backgroundColor = preview.state === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  previewItem.show();
}

/** Shows the instant the cursor's line stands for. */
export function refreshCursor(editor = vscode.window.activeTextEditor): void {
  const project = editor && editor.document.languageId === "python" ? projectForDocument(editor.document) : undefined;
  const data = project && !editor!.document.isDirty ? inspect.cached(project) : undefined;
  const point = data && pointAt(data, editor!.document.uri.fsPath, editor!.selection.active.line + 1);
  if (!point) {
    cursorItem.hide();
    return;
  }
  cursorItem.text = `$(clock) ${clock(point.time)}`;
  cursorItem.tooltip = `The instant this line stands for (${point.kind}${point.name ? ` ${point.name}` : ""}). Click to preview it.`;
  cursorItem.show();
}

export function dispose(): void {
  previewItem.dispose();
  cursorItem.dispose();
}
