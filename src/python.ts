// Completion from the project's environment.
//
// `gaanim init` puts the authoring package, with its type stubs, in the
// project's `.venv`, or in a workspace in the one `.venv` at its root. The
// Python extension picks a workspace's `.venv` on its own only at the window's
// root, so a project in a subfolder (or a window that chose another
// interpreter) is pointed at it here. In a workspace, scripts also import from
// folders other than their own (the shared Python folders, the member's):
// `gaanim project` names them, and the ones Pylance does not search on its own
// go to `python.analysis.extraPaths`, with the same consent as the interpreter.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { extraPathEntry, missingSearchPaths, resolveExtraPath, same } from "./core/workspace";
import { fallbackInterpreter, Project, requireProject } from "./project";
import * as workspace from "./workspace";

interface PythonApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string };
    updateActiveEnvironmentPath(environment: string, resource?: vscode.Uri): Promise<void>;
  };
}

const asked = new Set<string>();
/** Projects and workspaces whose environment the person accepted in this window. */
const accepted = new Set<string>();

async function api(): Promise<PythonApi | undefined> {
  const extension = vscode.extensions.getExtension<PythonApi>("ms-python.python");
  if (!extension) {
    return undefined;
  }
  try {
    return extension.isActive ? extension.exports : await extension.activate();
  } catch {
    return undefined;
  }
}

/** The environment a project's file runs in, and the folders its imports resolve from. */
export interface Environment {
  interpreter?: string;
  venv?: string;
  /** `sys.path` as Gaanim sets it, first to last; empty without `gaanim project`. */
  paths: string[];
  /** The workspace root, when the project is a member of one (or the file is one of its own). */
  workspaceRoot?: string;
}

/** What `gaanim project` says of a file's environment, else the `.venv` found beside the project or its workspace. */
export async function environment(project: Project, file = project.entry): Promise<Environment> {
  const { description } = await workspace.describe(file);
  if (description) {
    return {
      interpreter: description.python.interpreter,
      venv: description.python.venv,
      paths: description.python.paths,
      workspaceRoot: description.workspace?.root,
    };
  }
  const interpreter = fallbackInterpreter(project);
  return { interpreter, venv: interpreter && path.dirname(path.dirname(interpreter)), paths: [] };
}

/** The folders of `sys.path` Pylance would not find for `file`, and where they would be written. */
function searchPaths(file: string, env: Environment): { missing: string[]; folder?: vscode.WorkspaceFolder } {
  if (env.paths.length === 0 || !vscode.extensions.getExtension("ms-python.vscode-pylance")) {
    return { missing: [] };
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  if (!folder) {
    return { missing: [] };
  }
  const analysis = vscode.workspace.getConfiguration("python.analysis", folder.uri);
  const missing = missingSearchPaths(env.paths, {
    file,
    folder: folder.uri.fsPath,
    autoSearchPaths: analysis.get<boolean>("autoSearchPaths", true),
    extraPaths: analysis.get<string[]>("extraPaths", []),
  }).filter((dir) => fs.existsSync(dir));
  return { missing, folder };
}

async function addSearchPaths(folder: vscode.WorkspaceFolder, missing: string[]): Promise<void> {
  const analysis = vscode.workspace.getConfiguration("python.analysis", folder.uri);
  // The folder's value replaces the user's, so it starts from what applies now.
  const current = analysis.get<string[]>("extraPaths", []);
  const added = missing
    .filter((dir) => !current.some((entry) => same(resolveExtraPath(entry, folder.uri.fsPath), dir)))
    .map((dir) => extraPathEntry(dir, folder.uri.fsPath));
  if (added.length > 0) {
    await analysis.update("extraPaths", [...current, ...added], vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

function sameEnvironment(active: string | undefined, python: string): boolean {
  return Boolean(active && (same(active, python) || same(path.dirname(path.dirname(active)), path.dirname(path.dirname(python)))));
}

async function useInterpreter(project: Project, python: string): Promise<void> {
  const resource = vscode.Uri.file(project.entry);
  const environments = (await api())?.environments;
  if (environments) {
    await environments.updateActiveEnvironmentPath(python, resource);
  } else {
    await vscode.workspace
      .getConfiguration("python", resource)
      .update("defaultInterpreterPath", python, vscode.ConfigurationTarget.WorkspaceFolder)
      .then(undefined, () =>
        vscode.workspace.getConfiguration("python", resource).update("defaultInterpreterPath", python, vscode.ConfigurationTarget.Workspace),
      );
  }
}

interface Plan {
  python?: string;
  /** Switch to `python`: the active interpreter is another one. */
  switchTo: boolean;
  missing: string[];
  folder?: vscode.WorkspaceFolder;
  env: Environment;
}

async function plan(project: Project, file: string, known?: Environment): Promise<Plan> {
  const env = known ?? (await environment(project, file));
  const python = env.interpreter && fs.existsSync(env.interpreter) ? env.interpreter : undefined;
  const environments = (await api())?.environments;
  const active = environments?.getActiveEnvironmentPath(vscode.Uri.file(file))?.path;
  const switchTo = Boolean(python && environments && !sameEnvironment(active, python));
  return { python, switchTo, env, ...searchPaths(file, env) };
}

async function apply(project: Project, todo: Plan, quiet: boolean): Promise<void> {
  if (todo.python && todo.switchTo) {
    await useInterpreter(project, todo.python);
  }
  if (todo.folder && todo.missing.length > 0) {
    await addSearchPaths(todo.folder, todo.missing);
  }
  if (!quiet) {
    const parts: string[] = [];
    if (todo.python && todo.switchTo) {
      parts.push(`Python: ${path.relative(todo.env.workspaceRoot ?? project.root, todo.python)}`);
    }
    if (todo.missing.length > 0) {
      parts.push(`search paths: ${todo.missing.map((dir) => path.basename(dir)).join(", ")}`);
    }
    if (parts.length > 0) {
      vscode.window.setStatusBarMessage(parts.join(" · "), 4000);
    }
  }
}

/** When a project file opens: offers (or makes) the switch to the project's environment and its search paths. */
export async function checkProject(project: Project, file = project.entry): Promise<void> {
  const mode = config.pythonEnvironment();
  if (mode === "never") {
    return;
  }
  const env = await environment(project, file);
  const once = env.workspaceRoot ?? project.root;
  const again = mode === "always" || accepted.has(once);
  if (asked.has(once) && !again) {
    return;
  }
  const todo = await plan(project, file, env);
  if (!todo.switchTo && todo.missing.length === 0) {
    return;
  }
  if (again) {
    // Another member's file may need folders the first one did not.
    await apply(project, todo, true);
    return;
  }
  asked.add(once);
  const where = todo.env.workspaceRoot ? `The workspace of ${project.name}` : project.name;
  const what =
    todo.switchTo && todo.missing.length > 0
      ? "its own Python environment with Gaanim's types, and shared folders Pylance does not search. Use them for completion?"
      : todo.switchTo
        ? "its own Python environment with Gaanim's types. Use it for completion?"
        : `Python folders Pylance does not search (${todo.missing.map((dir) => path.basename(dir)).join(", ")}). Add them to python.analysis.extraPaths?`;
  const choice = await vscode.window.showInformationMessage(`${where} has ${what}`, todo.switchTo ? "Use .venv" : "Add", "Always", "Never");
  if (choice === "Use .venv" || choice === "Add") {
    accepted.add(once);
    await apply(project, todo, false);
  } else if (choice === "Always" || choice === "Never") {
    await vscode.workspace
      .getConfiguration("gaanim")
      .update("python.useProjectEnvironment", choice.toLowerCase(), vscode.ConfigurationTarget.Global);
    if (choice === "Always") {
      await apply(project, todo, false);
    }
  }
}

/** Gaanim: Use the Project's Python Environment. */
export async function useProjectPython(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const file = editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : project.entry;
  const todo = await plan(project, file);
  if (!todo.python) {
    void vscode.window.showWarningMessage(
      todo.env.workspaceRoot
        ? "This workspace has no .venv yet: open one of its members with gaanim once to prepare it."
        : "This project has no .venv yet: open it once with gaanim, or run gaanim init <kind> . --force.",
    );
    return;
  }
  await apply(project, { ...todo, switchTo: true }, false);
}
