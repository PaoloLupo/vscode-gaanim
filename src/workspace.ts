// Workspaces in the editor: what `gaanim project` says of each file, and the
// member a workspace's own files run as.
//
// A gaanim.toml with a `[workspace]` table lists member projects that share
// Python folders, assets and one `.venv`. The extension asks
// `gaanim project <path> --json` in the background what a file belongs to and
// keeps the answer, per folder, until a gaanim.toml is written. A workspace's
// own files (a shared module) run as its active member: the one whose files
// were opened last.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as cli from "./cli";
import { Description, decode, failure, isShared, label, manifestInfo, ManifestInfo, Member, Workspace, within } from "./core/workspace";
import { workspaceChanged } from "./events";

export interface Described {
  description?: Description;
  /** Why there is no description: no `gaanim project`, or an invalid manifest. */
  error?: string;
}

const NO_PROJECT = "This Gaanim cannot describe workspaces: `gaanim update` brings `gaanim project`.";

function key(file: string): string {
  const normalized = path.normalize(file).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The answer depends only on the folder: a folder's own key, or a file's folder. */
function cacheKey(target: string): string {
  return isDirectory(target) ? key(target) : `${key(path.dirname(target))}${path.sep}*`;
}

const settled = new Map<string, Described>();
const running = new Map<string, Promise<Described>>();
/** The workspaces described, by root. */
const workspaces = new Map<string, Workspace>();
/** Of each project described: its workspace's root, or false. */
const memberOf = new Map<string, string | false>();
let generation = 0;

function remember(description: Description): void {
  const workspace = description.workspace;
  if (workspace) {
    workspaces.set(key(workspace.root), workspace);
    for (const member of workspace.members) {
      if (member.root) {
        memberOf.set(key(member.root), workspace.root);
      }
    }
  }
  if (description.project) {
    memberOf.set(key(description.project.root), workspace ? workspace.root : false);
  }
}

async function ask(target: string): Promise<Described> {
  if (!(await cli.caps()).project) {
    return { error: NO_PROJECT };
  }
  const result = await cli.capture(["project", target, "--json"]);
  if (!result) {
    return { error: "Could not run gaanim project." };
  }
  if (result.code === 0) {
    try {
      // Paths as VS Code writes them (a lower-case drive letter), so a member
      // reached through its workspace is the same project as its open files.
      const description = decode(JSON.parse(result.stdout), (file) => vscode.Uri.file(file).fsPath);
      remember(description);
      return { description };
    } catch {
      return { error: "gaanim project printed no JSON." };
    }
  }
  return { error: failure(`${result.stderr}\n${result.stdout}`) || `gaanim project exited with ${result.code}.` };
}

/**
 * What `gaanim project` says of a file or folder, from the cache when it was
 * asked before. `fresh` asks again (members may have come or gone).
 */
export function describe(target: string, fresh = false): Promise<Described> {
  const k = cacheKey(target);
  const known = settled.get(k);
  if (known && !fresh) {
    return Promise.resolve(known);
  }
  const inFlight = running.get(k);
  if (inFlight && !fresh) {
    return inFlight;
  }
  const asked = generation;
  const promise = ask(target).then((result) => {
    if (asked === generation) {
      settled.set(k, result);
      if (running.get(k) === promise) {
        running.delete(k);
      }
      workspaceChanged.fire();
    }
    return result;
  });
  running.set(k, promise);
  return promise;
}

/** What is known of a file already, without waiting; asks in the background when nothing is. */
export function known(target: string): Described | undefined {
  const found = settled.get(cacheKey(target));
  if (!found) {
    void describe(target);
  }
  return found;
}

const manifests = new Map<string, { stamp: string; info: ManifestInfo }>();

/** What the gaanim.toml in `root` declares, read again only after it changes; undefined when there is none. */
export function manifest(root: string): ManifestInfo | undefined {
  const file = path.join(root, "gaanim.toml");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = manifests.get(file);
  if (cached && cached.stamp === stamp) {
    return cached.info;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const info = manifestInfo(text);
  manifests.set(file, { stamp, info });
  return info;
}

/** Whether the folder holds a workspace's manifest that names no project of its own. */
export function isRoot(root: string): boolean {
  const info = manifest(root);
  return Boolean(info?.workspace && !info.project);
}

/** The nearest workspace at or above `folder`, looking up to the folder that holds `.git`. */
export function rootAbove(folder: string): string | undefined {
  let dir = path.normalize(folder);
  for (let depth = 0; depth < 64; depth++) {
    if (manifest(dir)?.workspace) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, ".git"))) {
      return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/** The workspace at `root`, as last described. */
export function at(root: string): Workspace | undefined {
  return workspaces.get(key(root));
}

/** The workspace a project is a member of, as last described; asks in the background when that is not known yet. */
export function of(projectRoot: string): Workspace | undefined {
  const root = memberOf.get(key(projectRoot));
  if (root) {
    return workspaces.get(key(root));
  }
  if (root === undefined && rootAbove(path.dirname(projectRoot))) {
    void describe(projectRoot);
  }
  return undefined;
}

/** Whether a project is known to be a member of no workspace. */
export function standsAlone(projectRoot: string): boolean {
  return memberOf.get(key(projectRoot)) === false;
}

function listed(root: string, wanted: "python" | "assets"): string[] {
  const names = manifest(root)?.[wanted] ?? [wanted === "python" ? "src" : "assets"];
  return names.map((name) => path.join(root, name)).filter(isDirectory);
}

/** The shared Python folders of the workspace at `root`: as described, else as its manifest lists them. */
export function sharedPython(root: string): string[] {
  return at(root)?.python ?? listed(root, "python");
}

/** The shared asset folders a project finds files in after its own: its workspace's, when it is a member of one. */
export function sharedAssets(projectRoot: string, kind: string): string[] {
  const workspace = of(projectRoot);
  if (workspace) {
    return workspace.assets;
  }
  if (kind === "script" || standsAlone(projectRoot)) {
    return [];
  }
  // Not described yet: the workspace above, as its manifest says.
  const root = rootAbove(path.dirname(projectRoot));
  return root ? listed(root, "assets") : [];
}

/** Whether `file` is a module the members of the workspace at `root` share. */
export function isSharedFile(root: string, file: string): boolean {
  return isShared(sharedPython(root), file);
}

/** Forgets every answer, after a gaanim.toml is written, created or deleted. */
export function invalidate(): void {
  generation++;
  settled.clear();
  running.clear();
  workspaces.clear();
  memberOf.clear();
  manifests.clear();
  workspaceChanged.fire();
}

// The active member ------------------------------------------------------------

const ACTIVE = "gaanim.activeMembers";
let memento: vscode.Memento | undefined;
const active = new Map<string, string>();

/** Restores the active members of this window's workspaces. */
export function restore(state: vscode.Memento): void {
  memento = state;
  for (const [root, member] of Object.entries(state.get<Record<string, string>>(ACTIVE, {}))) {
    active.set(root, member);
  }
}

/** Makes the member at `memberRoot` the one the workspace's own files run as. */
export function use(root: string, memberRoot: string): void {
  const k = key(root);
  if (active.get(k) === path.normalize(memberRoot)) {
    return;
  }
  active.set(k, path.normalize(memberRoot));
  void memento?.update(ACTIVE, Object.fromEntries(active));
  workspaceChanged.fire();
}

/** The member a workspace's own files run as: the active one, else its only valid member. */
export function activeMember(root: string): string | undefined {
  const chosen = active.get(key(root));
  if (chosen && fs.existsSync(path.join(chosen, "gaanim.toml"))) {
    return chosen;
  }
  const workspace = at(root);
  const valid = workspace?.members.filter((member) => !member.error && member.root) ?? [];
  return valid.length === 1 ? valid[0].root : undefined;
}

/** When a file opens: a member's file makes its member the active one. */
export function onFile(file: string, projectRoot: string | undefined): void {
  if (!projectRoot || standsAlone(projectRoot)) {
    return;
  }
  const root = memberOf.get(key(projectRoot));
  if (root) {
    use(root, projectRoot);
    return;
  }
  if (rootAbove(path.dirname(projectRoot))) {
    void describe(file).then(({ description }) => {
      const project = description?.project;
      if (project && description.workspace && key(project.root) === key(projectRoot)) {
        use(description.workspace.root, project.root);
      }
    });
  }
}

// Picking members -----------------------------------------------------------------

/** The command to run again once a member is picked. */
let retry: (() => unknown) | undefined;

/** Remembers how to run again the command being run, for `choose`. */
export function setRetry(run: (() => unknown) | undefined): void {
  retry = run;
}

interface MemberItem extends vscode.QuickPickItem {
  member: Member;
}

/** Picks a member, by group, invalid ones marked; resolves to undefined when dismissed. */
export async function pickMember(workspace: Workspace, title: string, valid = false): Promise<Member | undefined> {
  const chosen = activeMember(workspace.root);
  const items: (MemberItem | vscode.QuickPickItem)[] = [];
  let group: string | undefined;
  for (const member of workspace.members) {
    if (valid && member.error) {
      continue;
    }
    if (member.group !== group) {
      group = member.group;
      if (group) {
        items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      }
    }
    items.push({
      label: `${member.error ? "$(error)" : member.kind === "slides" ? "$(preview)" : "$(device-camera-video)"} ${member.name}`,
      description: `${member.path}${chosen && key(chosen) === key(member.root) ? " · active" : ""}`,
      detail: member.error,
      member,
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  return picked && "member" in picked ? picked.member : undefined;
}

/**
 * For a workspace's own file when no member is active yet: the only member,
 * or one picked, becomes the active one, and the command that asked runs again.
 */
export async function choose(root: string): Promise<void> {
  const again = retry;
  const { description, error } = await describe(root);
  const workspace = description?.workspace;
  if (!workspace) {
    void vscode.window.showWarningMessage(error ?? `No Gaanim workspace in ${root}.`);
    return;
  }
  const valid = workspace.members.filter((member) => !member.error && member.root);
  if (valid.length === 0) {
    const choice = await vscode.window.showWarningMessage(`${workspace.name} has no members to run yet.`, "New Video…", "New Presentation…");
    if (choice) {
      await vscode.commands.executeCommand("gaanim.newMember", choice === "New Video…" ? "video" : "slides", workspace.root);
    }
    return;
  }
  const member = valid.length === 1 ? valid[0] : await pickMember(workspace, `Run the shared files of ${workspace.name} as`, true);
  if (!member) {
    return;
  }
  use(workspace.root, member.root);
  if (again) {
    await again();
  } else {
    vscode.window.setStatusBarMessage(`Shared files of ${workspace.name} run as ${label(member)}`, 4000);
  }
}

/** The workspace root around a file or folder: the one it is a member of, or whose own folders hold it. */
export function rootFor(target: string): string | undefined {
  return rootAbove(isDirectory(target) ? target : path.dirname(target));
}

/**
 * The workspace of the active editor, else of the window's first folder that
 * is in one, described afresh. Tells the person when there is none, unless `quiet`.
 */
export async function current(quiet = false): Promise<Workspace | undefined> {
  const editor = vscode.window.activeTextEditor;
  const candidates: string[] = [];
  if (editor?.document.uri.scheme === "file") {
    candidates.push(editor.document.uri.fsPath);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(folder.uri.fsPath);
  }
  let reason: string | undefined;
  for (const candidate of candidates) {
    const root = rootFor(candidate);
    if (!root) {
      continue;
    }
    for (const target of [candidate, root]) {
      const { description, error } = await describe(target, true);
      if (description?.workspace) {
        return description.workspace;
      }
      reason ??= error;
      if (error) {
        break;
      }
    }
  }
  if (!quiet) {
    void vscode.window.showWarningMessage(reason ?? "No Gaanim workspace here (no gaanim.toml with [workspace] above this file).");
  }
  return undefined;
}

/** The workspace at `root`, described afresh, or undefined after telling why. */
export async function load(root: string): Promise<Workspace | undefined> {
  const { description, error } = await describe(root, true);
  if (!description?.workspace) {
    void vscode.window.showWarningMessage(error ?? `No Gaanim workspace in ${root}.`);
  }
  return description?.workspace;
}

/** Whether a path lies in one of the window's folders. */
export function inWindow(file: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => within(file, folder.uri.fsPath));
}
