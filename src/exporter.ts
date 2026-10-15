// Rendering videos, PDFs, bundles and stills.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as check from "./check";
import * as cli from "./cli";
import { config, ExportPreset, presetNames } from "./config";
import { secondsArg } from "./core/clock";
import { pointAt, segmentAt } from "./core/timeline";
import * as inspect from "./inspect";
import { Project, projectForDocument, projectSymbols, requireProject, slideAtCursor } from "./project";

function safe(name: string): string {
  return name.replace(/[^\w.-]/g, "_");
}

function defaultOutput(project: Project, name: string, preset: ExportPreset, frame?: string, range?: string): string {
  let stem = project.name;
  if (range) {
    stem += `-${safe(range)}`;
  }
  if (name === "draft" || name === "notes" || name === "web") {
    stem += `-${name}`;
  } else if (frame) {
    stem += `-${safe(frame)}`;
  }
  return path.join(project.outputDir, `${stem}.${preset.ext}`);
}

async function opened(output: string): Promise<void> {
  const mode = config.export.open();
  const still = /\.(png|gif|webp)$/i.test(output);
  const uri = vscode.Uri.file(output);
  if (mode === "always" || (mode === "stills" && still)) {
    if (/\.(png|gif|webp|svg)$/i.test(output)) {
      await vscode.commands.executeCommand("vscode.open", uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    } else {
      await vscode.env.openExternal(uri);
    }
    return;
  }
  // Only offered: the export is done, so the command must not wait for an answer.
  void vscode.window
    .showInformationMessage(
      `Exported ${path.basename(output)}`,
      "Open",
      process.platform === "darwin" ? "Reveal in Finder" : "Reveal in File Explorer",
    )
    .then((choice) => {
      if (choice === "Open") {
        if (still) {
          void vscode.commands.executeCommand("vscode.open", uri, { viewColumn: vscode.ViewColumn.Beside });
        } else {
          void vscode.env.openExternal(uri);
        }
      } else if (choice) {
        void vscode.commands.executeCommand("revealFileInOS", uri);
      }
    });
}

/** Runs `gaanim <args>` with a cancellable progress notification; resolves to the exit code. */
function runWithProgress(project: Project, title: string, args: string[], key: string): Thenable<{
  code: number;
  lines: string[];
  objects: Record<string, unknown>[];
  cancelled: boolean;
}> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (progress, token) =>
      new Promise((resolve) => {
        let reported = 0;
        const job = cli.run(args, {
          cwd: project.root,
          key,
          onJson: (object) => {
            if (object.type === "progress" && typeof object.percent === "number") {
              const percent = Math.min(object.percent, 100);
              progress.report({ increment: percent - reported, message: `${Math.floor(percent)}%` });
              reported = percent;
            } else if (object.type === "message" && object.level === "info" && object.label !== "export" && object.message) {
              progress.report({ message: String(object.message) });
            }
          },
          onLine: (line) => {
            const info = /^\s\s▸\s+(\S+)\s+(.*)$/.exec(line);
            if (info && info[1] !== "export") {
              progress.report({ message: info[2] });
            }
            const percent = /(\d+(?:\.\d+)?)%/.exec(line);
            if (percent) {
              const value = Math.min(Number(percent[1]), 100);
              progress.report({ increment: value - reported, message: `${Math.floor(value)}%` });
              reported = value;
            }
          },
          onExit: (code, lines, objects) => resolve({ code, lines, objects, cancelled: token.isCancellationRequested }),
        });
        if (!job) {
          resolve({ code: -1, lines: [], objects: [], cancelled: false });
          return;
        }
        token.onCancellationRequested(() => cli.stop(key));
      }),
  );
}

/** Exports to `output` with extra `gaanim export` arguments. */
export async function run(project: Project, output: string, args: string[], preset?: ExportPreset): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const exportTo = preset?.packWeb ? output.replace(/\.gaanim$/, ".full.gaanim") : output;
  const command = ["export", project.target, "--output", exportTo, ...args];
  if ((await cli.caps()).json) {
    command.push("--message-format", "json");
  }
  const name = path.basename(output);
  const result = await runWithProgress(project, `Exporting ${name}`, command, `export:${output}`);
  if (result.cancelled) {
    vscode.window.setStatusBarMessage(`Export of ${name} cancelled`, 4000);
    return;
  }
  if (result.code !== 0) {
    const report = check.report(project, result.lines, result.objects);
    if (report.problems.length > 0) {
      check.publish(project, report);
    }
    void vscode.window.showErrorMessage(`✗ ${report.summary || "The export failed."}`, "Show Log").then((choice) => {
      if (choice) {
        cli.log.show(true);
      }
    });
    return;
  }
  if (preset?.packWeb) {
    const packed = await runWithProgress(project, `Packing ${name} for the web`, ["pack", exportTo, output, "--web"], `pack:${output}`);
    fs.rmSync(exportTo, { force: true });
    if (packed.code !== 0) {
      void vscode.window.showErrorMessage("gaanim pack --web failed; see the Gaanim log.");
      return;
    }
  }
  await opened(output);
}

/** The instant the cursor's line stands for (from the timeline), else the stop or segment around it by name. */
export async function frameAtCursor(project: Project, editor: vscode.TextEditor): Promise<{ frame: string; label: string } | undefined> {
  const data = await inspect.get(project);
  const point = data && pointAt(data, editor.document.uri.fsPath, editor.selection.active.line + 1);
  if (point) {
    return { frame: secondsArg(point.time), label: point.name ?? point.kind };
  }
  if ((await cli.caps()).names) {
    const here = slideAtCursor(editor);
    const name = here.stop?.name ?? here.segment?.name;
    if (name) {
      return { frame: name, label: name };
    }
  }
  return undefined;
}

/** The range of the slide under the cursor: by name when `export` takes names, else its times. */
export async function slideRange(project: Project, editor: vscode.TextEditor): Promise<{ from: string; to: string; name: string } | undefined> {
  const name = slideAtCursor(editor).segment?.name;
  if (name && (await cli.caps()).names) {
    return { from: name, to: name, name };
  }
  const data = await inspect.get(project);
  const point = data && pointAt(data, editor.document.uri.fsPath, editor.selection.active.line + 1);
  const segment = point && data ? segmentAt(data, point.time) : undefined;
  if (!segment) {
    void vscode.window.showWarningMessage("No slide under the cursor to export.");
    return undefined;
  }
  return { from: secondsArg(segment.start), to: secondsArg(segment.end), name: segment.name };
}

/** Asks for an instant: one of the scene's markers or slides, or a time in seconds. */
export async function askFrame(project: Project): Promise<string | undefined> {
  const items = projectSymbols(project)
    .filter((symbol) => symbol.name && (symbol.kind === "marker" || symbol.kind === "stop" || symbol.kind === "segment"))
    .map((symbol) => ({
      label: `${symbol.kind === "marker" ? "$(bookmark)" : symbol.kind === "stop" ? "$(debug-pause)" : "$(preview)"} ${symbol.name}`,
      description: `${path.basename(symbol.file)}:${symbol.line}`,
      value: symbol.name!,
    }));
  const quickPick = vscode.window.createQuickPick<{ label: string; description: string; value: string }>();
  quickPick.title = "Frame to export";
  quickPick.placeholder = "A marker, a slide, a stop, or a time in seconds";
  quickPick.items = items;
  return new Promise((resolve) => {
    let done = false;
    quickPick.onDidAccept(() => {
      done = true;
      const value = quickPick.selectedItems[0]?.value ?? quickPick.value.trim();
      quickPick.hide();
      resolve(value || undefined);
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      if (!done) {
        resolve(undefined);
      }
    });
    quickPick.show();
  });
}

async function pickPreset(project: Project, title: string, exclude: string[] = []): Promise<string | undefined> {
  const presets = config.export.presets();
  const picked = await vscode.window.showQuickPick(
    presetNames(presets)
      .filter((name) => !exclude.includes(name))
      .map((name) => ({ label: name, description: `.${presets[name].ext}`, detail: presets[name].desc })),
    { title: `${title} ${project.name}`, matchOnDetail: true },
  );
  return picked?.label;
}

/** Exports with a preset, asking for it when not given. */
export async function exportPreset(name?: string, extra: string[] = [], project = requireProject()): Promise<void> {
  if (!project) {
    return;
  }
  const chosen = name ?? (await pickPreset(project, "Export"));
  if (!chosen) {
    return;
  }
  const preset = config.export.presets()[chosen];
  if (!preset) {
    void vscode.window.showErrorMessage(`Unknown export preset: ${chosen}`);
    return;
  }
  const args = [...(preset.args ?? []), ...extra];
  let frame: string | undefined;
  const at = args.indexOf("--frame");
  if (at !== -1) {
    frame = args[at + 1];
  } else if (preset.ask === "frame") {
    frame = await askFrame(project);
    if (!frame) {
      return;
    }
    args.push("--frame", frame);
  }
  await run(project, defaultOutput(project, chosen, preset, frame), args, preset);
}

/** Exports the slide under the cursor with a preset (a draft MP4 from the code action). */
export async function exportSlide(name?: string, editor = vscode.window.activeTextEditor): Promise<void> {
  const project = editor && projectForDocument(editor.document);
  if (!editor || !project || editor.document.languageId !== "python") {
    void vscode.window.showWarningMessage("Put the cursor on a slide in a Gaanim script.");
    return;
  }
  const chosen = name ?? (await pickPreset(project, "Export the slide of", ["still", "bundle", "web"]));
  if (!chosen) {
    return;
  }
  const preset = config.export.presets()[chosen];
  const range = await slideRange(project, editor);
  if (!preset || !range) {
    return;
  }
  const args = [...(preset.args ?? []), "--from", range.from, "--to", range.to];
  await run(project, defaultOutput(project, chosen, preset, undefined, range.name), args, preset);
}

/** One PNG of the instant the cursor's line stands for, named after what the line is. */
export async function stillHere(editor = vscode.window.activeTextEditor): Promise<void> {
  const project = editor ? projectForDocument(editor.document) : requireProject();
  if (!project) {
    return;
  }
  const found = editor && editor.document.languageId === "python" ? await frameAtCursor(project, editor) : undefined;
  if (!found) {
    await exportPreset("still", [], project);
    return;
  }
  const output = path.join(project.outputDir, `${project.name}-${safe(found.label)}.png`);
  await run(project, output, ["--frame", found.frame]);
}

/** Asks for a marker, slide or time and exports its PNG. */
export async function stillPick(): Promise<void> {
  await exportPreset("still");
}
