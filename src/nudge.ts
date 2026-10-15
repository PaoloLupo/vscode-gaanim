// Nudging the number under the cursor by its own precision.

import * as vscode from "vscode";
import { numberAt, step } from "./core/nudge";

/** Moves the number at or after each cursor by `direction`; outside numbers it does nothing. */
export async function nudge(direction: 1 | -1): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const edits: { range: vscode.Range; text: string }[] = [];
  for (const selection of editor.selections) {
    const line = editor.document.lineAt(selection.active.line);
    const found = numberAt(line.text, selection.active.character);
    if (found) {
      edits.push({
        range: new vscode.Range(line.lineNumber, found.start, line.lineNumber, found.end),
        text: step(found.text, direction),
      });
    }
  }
  if (edits.length === 0) {
    return;
  }
  await editor.edit((builder) => {
    for (const edit of edits) {
      builder.replace(edit.range, edit.text);
    }
  });
  // Keep each cursor on the last digit, as CTRL-A does, so repeats keep nudging the same number.
  editor.selections = edits.map((edit) => {
    const position = new vscode.Position(edit.range.start.line, edit.range.start.character + edit.text.length - 1);
    return new vscode.Selection(position, position);
  });
}
