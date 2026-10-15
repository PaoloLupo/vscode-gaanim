// Creating and opening projects.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as cli from "./cli";
import { config, expandHome } from "./config";
import { listProjects, loadProject } from "./project";

/** A file to open once a project's window starts. */
const OPEN_ON_START = "gaanim.openOnStart";

const KINDS = [
  { label: "$(preview) slides", description: "a presentation: each segment is a slide, stop() waits for you", value: "slides" },
  { label: "$(device-camera-video) video", description: "an animation rendered to a video file", value: "video" },
];

/** Opens a project folder, in this window or a new one, then its entry script. */
export async function openProject(context: vscode.ExtensionContext, root: string): Promise<void> {
  const project = loadProject(root);
  if (!project) {
    void vscode.window.showWarningMessage(`${root} is not a Gaanim project.`);
    return;
  }
  const folder = vscode.Uri.file(project.root);
  if (vscode.workspace.getWorkspaceFolder(folder)) {
    await vscode.window.showTextDocument(vscode.Uri.file(project.entry));
    return;
  }
  let where = config.openIn();
  if (where === "ask") {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(window) Open in a new window", value: "newWindow" as const },
        { label: "$(folder-opened) Open in this window", value: "currentWindow" as const },
        { label: "$(add) Add to this workspace", value: "add" as const },
      ],
      { title: `Open ${project.name}` },
    );
    if (!picked) {
      return;
    }
    if (picked.value === "add") {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: folder });
      await vscode.window.showTextDocument(vscode.Uri.file(project.entry));
      return;
    }
    where = picked.value;
  }
  await context.globalState.update(OPEN_ON_START, project.entry);
  await vscode.commands.executeCommand("vscode.openFolder", folder, { forceNewWindow: where === "newWindow" });
}

/** On activation: opens the entry script of a project just created or picked. */
export async function openPending(context: vscode.ExtensionContext): Promise<void> {
  const pending = context.globalState.get<string>(OPEN_ON_START);
  if (!pending) {
    return;
  }
  const inWorkspace = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(pending));
  if (inWorkspace) {
    await context.globalState.update(OPEN_ON_START, undefined);
    if (fs.existsSync(pending)) {
      await vscode.window.showTextDocument(vscode.Uri.file(pending));
    }
  }
}

/** Creates a project with `gaanim init` and opens it. */
export async function newProject(context: vscode.ExtensionContext, kindArg?: string, nameArg?: string): Promise<void> {
  const kind = kindArg ?? (await vscode.window.showQuickPick(KINDS, { title: "New Gaanim project" }))?.value;
  if (!kind) {
    return;
  }
  const name =
    nameArg ??
    (await vscode.window.showInputBox({
      title: `New ${kind} project`,
      prompt: "Folder name, or a full path",
      validateInput: (value) => (value.trim() === "" ? "A name, such as talk" : undefined),
    }));
  if (!name) {
    return;
  }
  let dir: string;
  const expanded = expandHome(name.trim());
  if (path.isAbsolute(expanded) || expanded.startsWith(".")) {
    dir = path.resolve(expanded);
  } else {
    let base = config.projectsDir();
    if (!base) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: "Create Here",
        title: "Where to create the project (set gaanim.projectsDir to skip this)",
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir()),
      });
      if (!picked?.[0]) {
        return;
      }
      base = picked[0].fsPath;
    }
    dir = path.join(base, expanded);
  }
  if (fs.existsSync(path.join(dir, "gaanim.toml"))) {
    void vscode.window.showInformationMessage(`${dir} is already a Gaanim project; opening it.`);
    await openProject(context, dir);
    return;
  }
  const code = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Creating ${path.basename(dir)} (Python environment included)` },
    () =>
      new Promise<number>((resolve) => {
        const job = cli.run(["init", kind, dir], { onExit: (exit) => resolve(exit) });
        if (!job) {
          resolve(-1);
        }
      }),
  );
  if (code !== 0) {
    const choice = await vscode.window.showErrorMessage("gaanim init failed.", "Show Log");
    if (choice) {
      cli.log.show(true);
    }
    return;
  }
  if (config.newGit() && !fs.existsSync(path.join(dir, ".git")) && cli.which("git")) {
    await cli.output(cli.which("git")!, ["init", "--quiet", dir]);
  }
  await openProject(context, dir);
}

/** Picks one of the projects under `gaanim.projectsDir`, or a folder. */
export async function pickProject(context: vscode.ExtensionContext): Promise<void> {
  const projects = listProjects();
  const items: (vscode.QuickPickItem & { root?: string })[] = projects.map((project) => ({
    label: `${project.kind === "slides" ? "$(preview)" : "$(device-camera-video)"} ${project.name}`,
    description: project.kind,
    detail: project.root,
    root: project.root,
  }));
  items.push({ label: "$(folder-opened) Browse…", description: config.projectsDir() ? "" : "set gaanim.projectsDir to list your projects here" });
  const picked = await vscode.window.showQuickPick(items, { title: "Gaanim projects", matchOnDetail: true });
  if (!picked) {
    return;
  }
  let root = picked.root;
  if (!root) {
    const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Open Project" });
    root = folder?.[0]?.fsPath;
  }
  if (root) {
    await openProject(context, root);
  }
}
