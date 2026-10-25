// The integration suite, run inside VS Code by run.ts.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { GaanimApi } from "../../src/extension";

const real = Boolean(process.env.GAANIM_TEST_REAL);

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeout = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function cursorAt(editor: vscode.TextEditor, line: number): Promise<void> {
  await vscode.window.showTextDocument(editor.document);
  const position = new vscode.Position(line - 1, 0);
  editor.selection = new vscode.Selection(position, position);
}

const steps: [string, () => Promise<void>][] = [];
const step = (name: string, run: () => Promise<void>) => steps.push([name, run]);

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const main = path.join(root, "main.py");
  const document = await vscode.workspace.openTextDocument(main);
  let editor = await vscode.window.showTextDocument(document);
  const extension = vscode.extensions.getExtension<GaanimApi>("paololupo.gaanim")!;
  const api = await extension.activate();
  const project = { root } as Parameters<GaanimApi["timeline"]>[0];

  const data = await until("the timeline from gaanim inspect", () => api.timeline(project));
  const segments = data.segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const lastStop = last.stops![last.stops!.length - 1];

  step("inlay hints give each line its time", async () => {
    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      "vscode.executeInlayHintProvider",
      document.uri,
      new vscode.Range(0, 0, document.lineCount, 0),
    );
    const labels = hints.map((hint) => `${hint.position.line + 1}:${typeof hint.label === "string" ? hint.label : ""}`);
    assert.ok(labels.some((label) => label.startsWith(`${first.line}:▤`)), labels.join(", "));
    assert.ok(labels.some((label) => label.startsWith(`${lastStop.line}:⏸`)), labels.join(", "));
  });

  step("code lenses sit over each slide", async () => {
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", document.uri);
    const titles = lenses.filter((lens) => lens.range.start.line === first.line! - 1).map((lens) => lens.command?.title ?? "");
    assert.ok(titles.some((title) => title.includes("Preview")), titles.join(" | "));
    assert.ok(titles.some((title) => title.includes("Loop")), titles.join(" | "));
    assert.ok(titles.some((title) => title.includes("$(clock)")), titles.join(" | "));
  });

  step("document symbols list the slides", async () => {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", document.uri);
    const names = symbols.map((symbol) => symbol.name);
    for (const segment of segments) {
      assert.ok(names.includes(segment.name), names.join(", "));
    }
  });

  step("hover tells what a line makes", async () => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      document.uri,
      new vscode.Position(first.line! - 1, 2),
    );
    const text = hovers.flatMap((hover) => hover.contents.map((part) => (typeof part === "string" ? part : part.value))).join("\n");
    assert.match(text, new RegExp(`segment \\*\\*${first.name}\\*\\*`));
  });

  const scratch = path.join(root, "scratch.py");
  fs.writeFileSync(
    scratch,
    'from gaanim import Scene\nscene = Scene()\nlogo = scene.media.image("missing.png")\nx = scene.text.equation("x + alp")\ny = 0.5\n',
  );
  const scratchDocument = await vscode.workspace.openTextDocument(scratch);

  step("Typst math completes inside equation strings", async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      scratchDocument.uri,
      new vscode.Position(3, 'x = scene.text.equation("x + alp'.length),
    );
    const labels = list.items.map((item) => (typeof item.label === "string" ? item.label : item.label.label));
    assert.ok(labels.includes("alpha"), "alpha is offered");
  });

  step("a missing asset gets a warning", async () => {
    await until("the asset warning", () =>
      vscode.languages.getDiagnostics(scratchDocument.uri).find((diagnostic) => diagnostic.message.includes("missing.png")),
    );
  });

  step("nudging steps a decimal by its precision", async () => {
    const scratchEditor = await vscode.window.showTextDocument(scratchDocument);
    const position = new vscode.Position(4, 4);
    scratchEditor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand("gaanim.nudgeUp");
    assert.equal(scratchDocument.lineAt(4).text, "y = 0.6");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    fs.rmSync(scratch);
  });

  step("check reports on the project", async () => {
    editor = await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand("gaanim.check");
    const report = await until("the check report", () => api.reports.get(root));
    assert.notEqual(report.status, "error", report.summary);
    assert.match(report.summary, /segments/);
  });

  step("preview at cursor rests at the cursor's stop", async () => {
    await cursorAt(editor, lastStop.line!);
    await vscode.commands.executeCommand("gaanim.previewHere");
    const playhead = await until(
      "a playhead at the stop",
      () => {
        const head = api.previews.get(root)?.playhead;
        return head && !head.playing && (!real || head.stop === (lastStop.name ?? "")) ? head : undefined;
      },
      120_000,
    );
    assert.equal(api.previews.get(root)?.listen, true);
    if (real) {
      assert.equal(playhead.segment, last.name);
    }
  });

  step("loop toggles in the preview", async () => {
    await vscode.commands.executeCommand("gaanim.loop");
    await until("the loop", () => api.previews.get(root)?.playhead?.loop);
    await vscode.commands.executeCommand("gaanim.loop");
    await until("the loop off", () => (api.previews.get(root)?.playhead && !api.previews.get(root)?.playhead?.loop ? true : undefined));
  });

  step("closing the preview ends it", async () => {
    await vscode.commands.executeCommand("gaanim.stop");
    await until("the preview to close", () => (api.previews.get(root) ? undefined : true), 20_000);
  });

  step("a still exports the cursor's instant", async () => {
    await cursorAt(editor, lastStop.line!);
    await vscode.commands.executeCommand("gaanim.still");
    const exports = path.join(root, "exports");
    const png = await until(
      "the PNG",
      () => (fs.existsSync(exports) ? fs.readdirSync(exports).find((name) => name.endsWith(".png")) : undefined),
      120_000,
    );
    assert.ok(png.startsWith("talk-") || png.includes(lastStop.name ?? "stop"), png);
  });

  step("script goto opens the slide's section, adding it when missing", async () => {
    editor = await vscode.window.showTextDocument(document);
    await cursorAt(editor, first.line!);
    await vscode.commands.executeCommand("gaanim.scriptGoto");
    const script = await until("the script editor", () => {
      const active = vscode.window.activeTextEditor;
      return active && active.document.fileName.endsWith("script.md") ? active : undefined;
    });
    assert.ok(new RegExp(`^## ${first.name}$`, "mi").test(script.document.getText()), script.document.getText());
  });

  step("the script's lenses move the preview to a stop and go to its code", async () => {
    const script = await until("the script editor", () =>
      vscode.window.visibleTextEditors.find((candidate) => candidate.document.fileName.endsWith("script.md")),
    );
    const lenses = await until("the script's lenses", async () => {
      const found = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", script.document.uri);
      return found.some((lens) => lens.command?.command === "gaanim.scriptLens.preview") ? found : undefined;
    });
    const lines = script.document.getText().split(/\r?\n/);
    const heading = lines.findIndex((line) => line.trim().toLowerCase() === `## ${first.name.toLowerCase()}`);
    // The first slide's first mark when it has stops, else its heading.
    const mark = first.stops?.length ? lines.findIndex((line, index) => index > heading && /^\[stop\b/i.test(line.trim())) : heading;
    const at = (command: string) => lenses.find((lens) => lens.range.start.line === mark && lens.command?.command === command)!.command!;
    const preview = at("gaanim.scriptLens.preview");
    await vscode.commands.executeCommand(preview.command, ...preview.arguments!);
    const playhead = await until("a playhead from the script", () => api.previews.get(root)?.playhead, 120_000);
    if (real) {
      assert.equal(playhead.segment, first.name);
    }
    const code = at("gaanim.scriptLens.code");
    await vscode.commands.executeCommand(code.command, ...code.arguments!);
    const active = await until("the code", () =>
      vscode.window.activeTextEditor?.document.fileName.endsWith("main.py") ? vscode.window.activeTextEditor : undefined,
    );
    assert.equal(active.selection.active.line + 1, first.stops?.length ? first.stops[0].line : first.line);
  });

  let failed = 0;
  for (const [name, runStep] of steps) {
    try {
      await runStep();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}\n    ${String(error).split("\n").join("\n    ")}`);
    }
  }
  await vscode.commands.executeCommand("gaanim.stop");
  console.log(`${steps.length - failed} passed, ${failed} failed (${real ? "real gaanim" : "stand-in gaanim"})`);
  if (failed > 0) {
    throw new Error(`${failed} integration steps failed`);
  }
}
