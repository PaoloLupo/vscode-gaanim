// Creating and opening projects and workspaces.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as cli from "./cli";
import { config, expandHome } from "./config";
import { initWarnings, memberPath, same, Workspace } from "./core/workspace";
import { forgetRoots, listProjects, loadProject } from "./project";
import * as workspace from "./workspace";

/** A file to open once a project's window starts. */
const OPEN_ON_START = "gaanim.openOnStart";

const KINDS = [
  { label: "$(preview) slides", description: "a presentation: each segment is a slide, stop() waits for you", value: "slides" },
  { label: "$(device-camera-video) video", description: "an animation rendered to a video file", value: "video" },
];

const WORKSPACE_KIND = {
  label: "$(folder-library) workspace",
  description: "several projects in one repository that share code, assets and Python",
  value: "workspace",
};

/** Opens `folder` in this window or a new one (as `gaanim.new.openIn` says), then `file`. */
async function openFolder(context: vscode.ExtensionContext, folder: string, file: string, title: string): Promise<void> {
  const folderUri = vscode.Uri.file(folder);
  if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) || vscode.workspace.getWorkspaceFolder(folderUri)) {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
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
      { title: `Open ${title}` },
    );
    if (!picked) {
      return;
    }
    if (picked.value === "add") {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: folderUri });
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      return;
    }
    where = picked.value;
  }
  await context.globalState.update(OPEN_ON_START, file);
  await vscode.commands.executeCommand("vscode.openFolder", folderUri, { forceNewWindow: where === "newWindow" });
}

/** Opens a workspace's folder, then `file`: a member's entry, else its only member's, else its manifest. */
async function openWorkspace(context: vscode.ExtensionContext, root: string, file?: string): Promise<void> {
  const { description } = await workspace.describe(root, true);
  const found = description?.workspace;
  let target = file;
  if (!target && found) {
    const valid = found.members.filter((member) => !member.error && member.entry);
    target = valid.length === 1 ? valid[0].entry : undefined;
    if (valid.length === 1) {
      workspace.use(found.root, valid[0].root);
    }
  }
  await openFolder(context, root, target ?? path.join(root, "gaanim.toml"), found?.name ?? path.basename(root));
}

/**
 * Opens a project folder, in this window or a new one, then its entry script.
 * A workspace opens at its root; so does a member, which becomes the active one.
 */
export async function openProject(context: vscode.ExtensionContext, root: string): Promise<void> {
  if (workspace.isRoot(root)) {
    await openWorkspace(context, root);
    return;
  }
  const project = loadProject(root);
  if (!project) {
    void vscode.window.showWarningMessage(`${root} is not a Gaanim project.`);
    return;
  }
  const owner = await ownerOf(project.root);
  if (owner) {
    workspace.use(owner.root, project.root);
  }
  await openFolder(context, owner?.root ?? project.root, project.entry, project.name);
}

/** The workspace a project is a member of, as `gaanim project` says. */
async function ownerOf(projectRoot: string): Promise<Workspace | undefined> {
  if (!workspace.rootAbove(path.dirname(projectRoot))) {
    return undefined;
  }
  const found = (await workspace.describe(projectRoot)).description?.workspace;
  return found?.members.some((member) => same(member.root, projectRoot)) ? found : undefined;
}

/** Opens a member of a workspace: it becomes the active one, and its entry (or its manifest, when invalid) opens. */
export async function openMember(context: vscode.ExtensionContext, root: string, member: { root: string; entry?: string; error?: string }): Promise<void> {
  if (!member.error) {
    workspace.use(root, member.root);
  }
  await openWorkspace(context, root, member.entry ?? path.join(member.root, "gaanim.toml"));
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

/** Whether a name is a path of its own (absolute, or from `.` or `~`), not one inside the workspace or `gaanim.projectsDir`. */
function explicit(name: string): boolean {
  const expanded = expandHome(name.trim());
  return path.isAbsolute(expanded) || expanded.startsWith(".");
}

/** The folder a new project or workspace named `name` goes in: a path, or a name under `gaanim.projectsDir` (asked for when unset). */
async function folderFor(name: string, what: string): Promise<string | undefined> {
  const expanded = expandHome(name.trim());
  if (explicit(name)) {
    return path.resolve(expanded);
  }
  let base = config.projectsDir();
  if (!base) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: "Create Here",
      title: `Where to create the ${what} (set gaanim.projectsDir to skip this)`,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir()),
    });
    if (!picked?.[0]) {
      return undefined;
    }
    base = picked[0].fsPath;
  }
  return path.join(base, expanded);
}

/** Runs `gaanim init <kind> <dir>` with a progress notification; resolves to its exit code and output. */
function init(kind: string, dir: string, title: string): Thenable<{ code: number; lines: string[] }> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    () =>
      new Promise<{ code: number; lines: string[] }>((resolve) => {
        const job = cli.run(["init", kind, dir], { onExit: (code, lines) => resolve({ code, lines }) });
        if (!job) {
          resolve({ code: -1, lines: [] });
        }
      }),
  );
}

async function failed(): Promise<void> {
  const choice = await vscode.window.showErrorMessage("gaanim init failed.", "Show Log");
  if (choice) {
    cli.log.show(true);
  }
}

/**
 * Creates a project with `gaanim init` and opens it. Inside a workspace a
 * video or presentation becomes one of its members.
 */
export async function newProject(context: vscode.ExtensionContext, kindArg?: string, nameArg?: string): Promise<void> {
  const caps = await cli.caps();
  const kinds = caps.project ? [...KINDS, WORKSPACE_KIND] : KINDS;
  const kind = kindArg ?? (await vscode.window.showQuickPick(kinds, { title: "New Gaanim project" }))?.value;
  if (!kind) {
    return;
  }
  if (kind === "workspace") {
    await newWorkspace(context, nameArg);
    return;
  }
  if (caps.project && !(nameArg && explicit(nameArg))) {
    const here = await workspace.current(true);
    if (here) {
      await newMember(context, here, kind, nameArg);
      return;
    }
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
  const dir = await folderFor(name, "project");
  if (!dir) {
    return;
  }
  if (fs.existsSync(path.join(dir, "gaanim.toml"))) {
    void vscode.window.showInformationMessage(`${dir} is already a Gaanim project; opening it.`);
    await openProject(context, dir);
    return;
  }
  const { code, lines } = await init(kind, dir, `Creating ${path.basename(dir)} (Python environment included)`);
  if (code !== 0) {
    await failed();
    return;
  }
  showWarnings(lines);
  workspace.invalidate();
  forgetRoots();
  if (config.newGit() && !fs.existsSync(path.join(dir, ".git")) && !workspace.rootAbove(path.dirname(dir)) && cli.which("git")) {
    await cli.output(cli.which("git")!, ["init", "--quiet", dir]);
  }
  await openProject(context, dir);
}

/** Shows what `gaanim init` warned about, such as a folder the workspace's `members` leaves out. */
function showWarnings(lines: string[], manifest?: string): void {
  for (const warning of initWarnings(lines)) {
    const actions = manifest && /members/.test(warning) ? ["Open gaanim.toml"] : [];
    void vscode.window.showWarningMessage(warning, ...actions).then((choice) => {
      if (choice && manifest) {
        void vscode.window.showTextDocument(vscode.Uri.file(manifest));
      }
    });
  }
}

/**
 * Creates a workspace with `gaanim init workspace` (its first member, shared
 * folders, `.venv` and Git repository included) and opens its first member.
 */
export async function newWorkspace(context: vscode.ExtensionContext, nameArg?: string): Promise<void> {
  if (!(await cli.caps()).project) {
    void vscode.window.showWarningMessage("Workspaces need a newer Gaanim: run gaanim update.");
    return;
  }
  const name =
    nameArg ??
    (await vscode.window.showInputBox({
      title: "New Gaanim workspace",
      prompt: "Folder name, or a full path: several videos and talks that share code, assets and Python",
      validateInput: (value) => (value.trim() === "" ? "A name, such as channel" : undefined),
    }));
  if (!name) {
    return;
  }
  const dir = await folderFor(name, "workspace");
  if (!dir) {
    return;
  }
  if (fs.existsSync(path.join(dir, "gaanim.toml"))) {
    void vscode.window.showInformationMessage(`${dir} already has a gaanim.toml; opening it.`);
    await openProject(context, dir);
    return;
  }
  const { code, lines } = await init("workspace", dir, `Creating ${path.basename(dir)} (Git repository and Python environment included)`);
  if (code !== 0) {
    await failed();
    return;
  }
  showWarnings(lines);
  workspace.invalidate();
  forgetRoots();
  await openProject(context, dir);
}

/**
 * Adds a member to a workspace with `gaanim init <kind>`, which writes only
 * the member's files (the environment is the workspace's), beside the other
 * members of its kind, then opens it as the active member.
 */
export async function newMember(context: vscode.ExtensionContext, target?: Workspace | string, kindArg?: string, nameArg?: string): Promise<void> {
  const found = typeof target === "string" ? await workspace.load(target) : (target ?? (await workspace.current()));
  if (!found) {
    return;
  }
  const kind =
    kindArg ?? (await vscode.window.showQuickPick(KINDS, { title: `New member of ${found.name}` }))?.value;
  if (!kind) {
    return;
  }
  const what = kind === "slides" ? "presentation" : "video";
  const active = workspace.activeMember(found.root);
  let name = nameArg;
  if (!name) {
    const folder = memberPath(found, kind, undefined, active);
    name = (
      await vscode.window.showInputBox({
        title: `New ${what} in ${found.name}`,
        prompt: "Its folder in the workspace: a name beside the others, or a path from the workspace's root",
        value: folder,
        valueSelection: [folder.length, folder.length],
        validateInput: (value) => (value.trim() === "" || value.trim().endsWith("/") ? "A folder name, such as ep2" : undefined),
      })
    )?.trim();
  }
  if (!name) {
    return;
  }
  const dir = explicit(name) ? path.resolve(expandHome(name)) : path.join(found.root, ...memberPath(found, kind, name, active).split("/"));
  if (fs.existsSync(path.join(dir, "gaanim.toml"))) {
    void vscode.window.showInformationMessage(`${dir} is already a Gaanim project; opening it.`);
    await openProject(context, dir);
    return;
  }
  const { code, lines } = await init(kind, dir, `Creating ${path.relative(found.root, dir) || path.basename(dir)} in ${found.name}`);
  if (code !== 0) {
    await failed();
    return;
  }
  showWarnings(lines, found.manifest);
  workspace.invalidate();
  forgetRoots();
  const project = loadProject(dir);
  if (!project) {
    return;
  }
  // Only a member runs the shared files: `members` may leave the new folder out.
  const owner = await ownerOf(project.root);
  if (owner) {
    workspace.use(owner.root, project.root);
  }
  await openFolder(context, found.root, project.entry, project.name);
}

/** Picks one of the projects or workspaces under `gaanim.projectsDir`, or a folder. */
export async function pickProject(context: vscode.ExtensionContext): Promise<void> {
  const projects = listProjects();
  const items: (vscode.QuickPickItem & { root?: string })[] = projects.map((project) => ({
    label: `${project.kind === "workspace" ? "$(folder-library)" : project.kind === "slides" ? "$(preview)" : "$(device-camera-video)"} ${project.name}`,
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
