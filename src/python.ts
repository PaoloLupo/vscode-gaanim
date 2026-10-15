// Completion from the project's environment.
//
// `gaanim init` puts the authoring package, with its type stubs, in the
// project's `.venv`. The Python extension picks a workspace's `.venv` on its
// own only at the workspace root, so a project in a subfolder (or a window
// that chose another interpreter) is pointed at it here.

import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { interpreter, Project, requireProject } from "./project";

interface PythonApi {
  environments?: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { path: string };
    updateActiveEnvironmentPath(environment: string, resource?: vscode.Uri): Promise<void>;
  };
}

const asked = new Set<string>();

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

function same(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

async function use(project: Project, python: string, quiet: boolean): Promise<boolean> {
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
  if (!quiet) {
    vscode.window.setStatusBarMessage(`Python: ${path.relative(project.root, python)}`, 4000);
  }
  return true;
}

/** When a project file opens: offers (or makes) the switch to the project's `.venv`. */
export async function checkProject(project: Project): Promise<void> {
  const mode = config.pythonEnvironment();
  if (mode === "never" || asked.has(project.root)) {
    return;
  }
  const python = interpreter(project.root);
  const environments = (await api())?.environments;
  if (!python || !environments) {
    return;
  }
  asked.add(project.root);
  const active = environments.getActiveEnvironmentPath(vscode.Uri.file(project.entry))?.path;
  if (active && (same(active, python) || same(path.dirname(path.dirname(active)), path.dirname(path.dirname(python))))) {
    return;
  }
  if (mode === "always") {
    await use(project, python, true);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${project.name} has its own Python environment with Gaanim's types. Use it for completion?`,
    "Use .venv",
    "Always",
    "Never",
  );
  if (choice === "Use .venv") {
    await use(project, python, false);
  } else if (choice === "Always" || choice === "Never") {
    await vscode.workspace
      .getConfiguration("gaanim")
      .update("python.useProjectEnvironment", choice.toLowerCase(), vscode.ConfigurationTarget.Global);
    if (choice === "Always") {
      await use(project, python, false);
    }
  }
}

/** Gaanim: Use the Project's Python Environment. */
export async function useProjectPython(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const python = interpreter(project.root);
  if (!python) {
    void vscode.window.showWarningMessage("This project has no .venv yet: open it once with gaanim, or run gaanim init <kind> . --force.");
    return;
  }
  await use(project, python, false);
}
