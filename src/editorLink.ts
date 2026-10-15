// Opening lines from Gaanim in this window.
//
// Gaanim opens a script line in the editor `GAANIM_EDITOR` names (the
// inspector, the console, a double click on the animation timeline, the error
// panel and *Open and complete*). Previews started here get a command that
// reaches this window: this editor's command line tool with `--reuse-window`,
// else a `vscode://` link to the extension's URI handler.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";

const EXTENSION_ID = "paololupo.gaanim";

/** This editor's command line tool (`code`, `cursor`, `codium`…), next to its app. */
function cliTool(): string | undefined {
  const appRoot = vscode.env.appRoot;
  const dirs = [path.join(appRoot, "bin"), path.join(appRoot, "..", "..", "bin")];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const wanted =
      process.platform === "win32"
        ? names.filter((name) => name.toLowerCase().endsWith(".cmd"))
        : names.filter((name) => !name.includes(".") && !name.endsWith("-tunnel"));
    const pick = wanted.find((name) => !/tunnel/i.test(name));
    if (pick) {
      return path.join(dir, pick);
    }
  }
  return undefined;
}

/** The link the URI handler opens, with placeholders Gaanim fills. */
function uriCommand(): string {
  const link = `${vscode.env.uriScheme}://${EXTENSION_ID}/open?line={line}&file={file}`;
  switch (process.platform) {
    case "win32":
      return `explorer.exe "${link}"`;
    case "darwin":
      return `open "${link}"`;
    default:
      return `xdg-open "${link}"`;
  }
}

/** The `GAANIM_EDITOR` command for previews started from this window. */
export function editorCommand(): string {
  const configured = config.preview.editorCommand();
  if (configured) {
    return configured;
  }
  // In a remote window the preview runs where the extension runs, and the
  // tool found there (the server's `code`) still reaches this window.
  const tool = cliTool();
  return tool ? `"${tool}" --reuse-window --goto "{file}:{line}"` : uriCommand();
}

/** Opens `file` at a 1-based line in this window. */
export async function openAt(file: string, line: number, column = 0): Promise<vscode.TextEditor | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const position = new vscode.Position(Math.max(line - 1, 0), column);
    const editor = await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(position, position),
      preview: false,
    });
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return editor;
  } catch (error) {
    void vscode.window.showWarningMessage(`Could not open ${file}: ${String(error)}`);
    return undefined;
  }
}

/** `vscode://paololupo.gaanim/open?file=…&line=…`, from previews without a command line tool. */
export class UriHandler implements vscode.UriHandler {
  handleUri(uri: vscode.Uri): void {
    if (uri.path !== "/open") {
      return;
    }
    // The file comes last and unescaped: Gaanim fills it in as it is.
    const query = uri.query;
    const lineMatch = /(?:^|&)line=(\d+)/.exec(query);
    const fileIndex = query.indexOf("file=");
    if (fileIndex === -1) {
      return;
    }
    let file = query.slice(fileIndex + 5);
    try {
      file = decodeURIComponent(file);
    } catch {
      // Already plain.
    }
    void openAt(file, lineMatch ? Number(lineMatch[1]) : 1);
  }
}
