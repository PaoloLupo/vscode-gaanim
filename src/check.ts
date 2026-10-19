// `gaanim check` in the background, as problems on their lines.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as cli from "./cli";
import { config } from "./config";
import { fromJson, fromText, LocateContext, Problem, Report, warningRefs } from "./core/check";
import { findSection, parseScript } from "./core/script";
import { checkSummary, count, failed, Member, memberReports, stripVerbatim, Workspace } from "./core/workspace";
import { findSymbol, loadProject, Project, projectSymbols, requireProject } from "./project";
import { readLines, scriptPath } from "./narration";

export const diagnostics = vscode.languages.createDiagnosticCollection("gaanim");

/** The last report of each project. */
export const lastReport = new Map<string, Report>();

const published = new Map<string, Set<string>>();

/** The place a warning is about: the line it names, its script mark, its stop or segment. */
export function locateContext(project: Project): LocateContext {
  return {
    root: project.root,
    fallback: project.manifest ?? project.entry,
    locate(text) {
      const refs = warningRefs(text);
      const script = scriptPath(project);
      if (refs.markdown) {
        const file = path.basename(script.path) === refs.markdown.file ? script.path : path.join(project.root, refs.markdown.file);
        return { file, line: refs.markdown.line };
      }
      if (refs.segment && refs.mark && script.exists) {
        const lines = readLines(script.path);
        const section = findSection(parseScript(lines), refs.segment);
        const from = section ? section.line : 1;
        for (let i = from - 1; i < lines.length; i++) {
          if (lines[i].includes(refs.mark)) {
            return { file: script.path, line: i + 1 };
          }
        }
      }
      if (refs.stop) {
        const stop = projectSymbols(project).find((symbol) => symbol.kind === "stop" && symbol.name === refs.stop);
        if (stop) {
          return { file: stop.file, line: stop.line };
        }
      }
      if (refs.segment) {
        const symbol = findSymbol(project, refs.segment);
        if (symbol) {
          return { file: symbol.file, line: symbol.line };
        }
      }
      return undefined;
    },
  };
}

function toDiagnostic(problem: Problem): vscode.Diagnostic {
  const line = Math.max(problem.line - 1, 0);
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(line, Math.max(problem.column - 1, 0), line, Number.MAX_SAFE_INTEGER),
    problem.text,
    problem.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
  );
  diagnostic.source = "gaanim";
  return diagnostic;
}

/** Shows a report's problems, replacing the project's previous ones. */
export function publish(project: Project, report: Report): void {
  for (const file of published.get(project.root) ?? []) {
    diagnostics.delete(vscode.Uri.file(file));
  }
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const problem of report.problems) {
    const file = path.normalize(problem.file);
    byFile.set(file, [...(byFile.get(file) ?? []), toDiagnostic(problem)]);
  }
  for (const [file, list] of byFile) {
    diagnostics.set(vscode.Uri.file(file), list);
  }
  published.set(project.root, new Set(byFile.keys()));
}

/** Clears the project's problems, once a reload succeeds after a failure. */
export function clear(project: Project): void {
  publish(project, { status: "pass", summary: "", problems: [] });
}

/** Reads a finished command's output into a report: JSON when there is any, else the text. */
export function report(project: Project, lines: string[], objects: Record<string, unknown>[]): Report {
  const context = locateContext(project);
  return objects.length > 0 ? fromJson(objects, lines, context) : fromText(lines, context);
}

export async function run(project: Project | undefined = requireProject(), quiet = false): Promise<void> {
  if (!project) {
    return;
  }
  const args = ["check", project.target];
  if (config.check.strict()) {
    args.push("--strict");
  }
  if ((await cli.caps()).json) {
    args.push("--message-format", "json");
  }
  cli.run(args, {
    cwd: project.root,
    key: `check:${project.root}`,
    onExit: (code, lines, objects) => {
      const result = report(project, lines, objects);
      if (code !== 0 && code !== 1 && result.problems.length === 0) {
        if (!quiet) {
          void vscode.window.showErrorMessage("gaanim check failed; see the Gaanim log.", "Show Log").then((choice) => {
            if (choice) {
              cli.log.show(true);
            }
          });
        }
        return;
      }
      lastReport.set(project.root, result);
      publish(project, result);
      const reveal = config.check.revealProblems();
      if (reveal === "always" || (reveal === "errors" && result.status === "error")) {
        void vscode.commands.executeCommand("workbench.actions.view.problems");
      }
      if (result.status === "error") {
        void vscode.window.showErrorMessage(`✗ ${result.summary}`);
      } else if (!quiet) {
        const count = result.problems.length;
        if (count > 0) {
          void vscode.window.showWarningMessage(`${count} warning${count === 1 ? "" : "s"} · ${result.summary}`);
        } else {
          void vscode.window.showInformationMessage(`✓ ${result.summary}`);
        }
      }
    },
  });
}

/** The project of a member, or a stand-in for one whose manifest is invalid, so its problems have a place. */
export function memberAsProject(member: Member): Project {
  return (
    loadProject(member.root) ?? {
      root: member.root,
      target: member.root,
      manifest: path.join(member.root, "gaanim.toml"),
      name: member.name,
      kind: member.kind ?? "video",
      entry: member.entry ?? path.join(member.root, "gaanim.toml"),
      assetsDir: path.join(member.root, "assets"),
      outputDir: path.join(member.root, "exports"),
      raw: {},
    }
  );
}

/** The last check of each workspace, by root. */
export const lastWorkspaceReport = new Map<string, { summary: string; members: Map<string, Report> }>();

/**
 * Checks every member of a workspace (or the `members` given, paths as
 * `--members` takes them) in one `gaanim check`: each member's problems go
 * to its files, and a summary says how many passed.
 */
export async function runWorkspace(workspace: Workspace, members?: string[]): Promise<void> {
  const args = ["check", workspace.root, "--message-format", "json"];
  if (members && members.length > 0) {
    args.push("--members", members.join(","));
  }
  if (config.check.strict()) {
    args.push("--strict");
  }
  const total = members?.length || workspace.members.length;
  const key = `check:${workspace.root}`;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking ${workspace.name}`, cancellable: true },
    (progress, token) =>
      new Promise<void>((resolve) => {
        let done = 0;
        progress.report({ message: count(total) });
        const job = cli.run(args, {
          cwd: workspace.root,
          key,
          onJson: (object) => {
            if (object.type === "check" && typeof object.member === "string") {
              done++;
              const glyph = failed(object) ? "✗" : object.warnings ? "!" : "✓";
              progress.report({ increment: 100 / Math.max(total, 1), message: `${glyph} ${object.member} (${done}/${total})` });
            }
          },
          onExit: (code, _lines, objects) => {
            resolve();
            if (token.isCancellationRequested) {
              return;
            }
            const results = memberReports(workspace, objects, (member) => locateContext(memberAsProject(member)));
            if (results.length === 0) {
              const reason = objects.map((object) => object.message).find((message) => typeof message === "string");
              void vscode.window
                .showErrorMessage(`✗ ${reason ? stripVerbatim(String(reason)) : `gaanim check failed (exit ${code}); see the Gaanim log.`}`, "Show Log")
                .then((choice) => choice && cli.log.show(true));
              return;
            }
            const byMember = new Map<string, Report>();
            for (const { member, report } of results) {
              const project = memberAsProject(member);
              lastReport.set(project.root, report);
              publish(project, report);
              byMember.set(member.path, report);
            }
            const summary = checkSummary(results.map(({ member, report }) => ({ member: member.path, status: report.status })));
            lastWorkspaceReport.set(workspace.root, { summary, members: byMember });
            const anyFailed = results.some(({ report }) => report.status === "error");
            const reveal = config.check.revealProblems();
            if (reveal === "always" || (reveal === "errors" && anyFailed)) {
              void vscode.commands.executeCommand("workbench.actions.view.problems");
            }
            const show = anyFailed ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
            void show(`${anyFailed ? "✗" : "✓"} ${workspace.name}: ${summary}`, "Show Problems").then((choice) => {
              if (choice) {
                void vscode.commands.executeCommand("workbench.actions.view.problems");
              }
            });
            checked.fire(workspace.root);
          },
        });
        if (!job) {
          resolve();
          return;
        }
        token.onCancellationRequested(() => cli.stop(key));
      }),
  );
}

/** A workspace's check finished, by root: the Projects view marks its members. */
export const checked = new vscode.EventEmitter<string>();

let timer: NodeJS.Timeout | undefined;

/** After a save in a project: checks it once the saves settle. */
export function onSave(project: Project): void {
  if (!config.check.onSave() || !fs.existsSync(project.target)) {
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => void run(project, true), config.check.debounce());
}
