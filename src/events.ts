// What changes, for the parts of the extension that show it.

import * as vscode from "vscode";

/** A project's timeline arrived or went stale. */
export const timelineChanged = new vscode.EventEmitter<string>();

/** A project's preview started, reloaded, failed, closed, moved or changed mode. */
export const previewChanged = new vscode.EventEmitter<string>();

/** A project's narration script changed or was opened. */
export const scriptChanged = new vscode.EventEmitter<string>();

export function disposeEvents(): void {
  timelineChanged.dispose();
  previewChanged.dispose();
  scriptChanged.dispose();
}
