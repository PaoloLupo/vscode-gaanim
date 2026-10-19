// The Gaanim side bar: the project's timeline and the projects folder.

import * as path from "node:path";
import * as vscode from "vscode";
import * as check from "./check";
import { clock } from "./core/clock";
import { count, groups, label, Member, same, Workspace } from "./core/workspace";
import * as workspace from "./workspace";
import { STRUCTURE } from "./core/symbols";
import { entries, TimelineEntry } from "./core/timeline";
import { previewChanged, timelineChanged } from "./events";
import * as inspect from "./inspect";
import { status } from "./preview";
import { currentProject, listProjects, Project, projectSymbols } from "./project";

const ICONS: Record<TimelineEntry["kind"], string> = {
  segment: "preview",
  section: "symbol-namespace",
  stop: "debug-pause",
  marker: "bookmark",
  voiceover: "mic",
};

export interface EntryNode {
  entry: TimelineEntry;
  children: EntryNode[];
  /** From the Python alone: no times. */
  outline: boolean;
}

/** The timeline when it is known, else the outline read from the Python. */
function nodesFor(project: Project): { nodes: EntryNode[]; fromTimeline: boolean } {
  const data = inspect.cached(project);
  const list: { entry: TimelineEntry; outline: boolean }[] = data
    ? entries(data).map((entry) => ({ entry, outline: false }))
    : projectSymbols(project)
        .filter((symbol) => STRUCTURE.has(symbol.kind))
        .map((symbol) => ({
          outline: true,
          entry: {
            kind: symbol.kind as TimelineEntry["kind"],
            label: symbol.name ?? "(stop)",
            time: 0,
            file: symbol.file,
            line: symbol.line,
            seek:
              symbol.kind === "segment" || symbol.kind === "section"
                ? { cmd: "seek" as const, segment: symbol.name }
                : { cmd: "seek" as const },
            segment: symbol.kind === "segment" || symbol.kind === "section" ? symbol.name : undefined,
          },
        }));
  const nodes: EntryNode[] = [];
  let parent: EntryNode | undefined;
  for (const item of list) {
    const node: EntryNode = { ...item, children: [] };
    if (item.entry.kind === "segment" || item.entry.kind === "section") {
      parent = node;
      nodes.push(node);
    } else if (parent) {
      parent.children.push(node);
    } else {
      nodes.push(node);
    }
  }
  return { nodes, fromTimeline: Boolean(data) };
}

export class TimelineTree implements vscode.TreeDataProvider<EntryNode> {
  private readonly changed = new vscode.EventEmitter<EntryNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private view?: vscode.TreeView<EntryNode>;
  private project?: Project;

  constructor() {
    timelineChanged.event(() => this.refresh());
    previewChanged.event(() => this.updateDescription());
  }

  attach(view: vscode.TreeView<EntryNode>): void {
    this.view = view;
  }

  refresh(): void {
    this.changed.fire(undefined);
    this.updateDescription();
  }

  private updateDescription(): void {
    if (!this.view) {
      return;
    }
    const project = currentProject();
    const data = project && inspect.cached(project);
    const playhead = project && status.get(project.root)?.playhead;
    const parts = [project?.name, data ? clock(data.duration) : undefined, playhead ? `at ${clock(playhead.time)}` : undefined];
    this.view.description = parts.filter(Boolean).join(" · ");
    this.view.message = project && !data && inspect.isStale(project) ? "Times appear once the scene runs (preview or gaanim inspect)." : undefined;
  }

  getChildren(node?: EntryNode): EntryNode[] {
    if (node) {
      return node.children;
    }
    const project = currentProject();
    this.project = project;
    if (!project) {
      return [];
    }
    if (!inspect.cached(project) && inspect.isStale(project)) {
      void inspect.get(project);
    }
    return nodesFor(project).nodes;
  }

  getTreeItem(node: EntryNode): vscode.TreeItem {
    const { entry } = node;
    const item = new vscode.TreeItem(
      entry.label,
      node.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(ICONS[entry.kind]);
    const where = entry.file && entry.line && this.project ? `${path.relative(this.project.root, entry.file)}:${entry.line}` : "";
    if (!node.outline) {
      item.description = entry.end !== undefined && entry.kind !== "stop" ? `${clock(entry.time)}–${clock(entry.end)}` : clock(entry.time);
    }
    item.tooltip = new vscode.MarkdownString(
      `**${entry.label}** · ${entry.kind}${node.outline ? "" : ` · ${item.description}`}${where ? `\n\n\`${where}\`` : ""}`,
    );
    const slide = entry.kind === "segment" || entry.kind === "section";
    item.contextValue = `gaanim.${slide ? "slide" : entry.kind}`;
    item.command = { title: "Go", command: "gaanim.entry.go", arguments: [node] };
    return item;
  }
}

export type ProjectsNode =
  | { type: "project"; project: Project }
  | { type: "workspace"; root: string; name: string; inWindow: boolean }
  | { type: "group"; workspace: Workspace; name: string; members: Member[] }
  | { type: "member"; workspace: Workspace; member: Member };

const MEMBER_ICONS: Record<string, string> = { slides: "preview", video: "device-camera-video" };

/** The window's folders that are workspaces or lie in one: they head the list. */
function windowWorkspaces(): string[] {
  const roots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = workspace.rootFor(folder.uri.fsPath);
    if (root && !roots.some((other) => same(other, root))) {
      roots.push(root);
    }
  }
  return roots;
}

export class ProjectsTree implements vscode.TreeDataProvider<ProjectsNode> {
  private readonly changed = new vscode.EventEmitter<ProjectsNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor() {
    check.checked.event(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  async getChildren(node?: ProjectsNode): Promise<ProjectsNode[]> {
    if (!node) {
      const nodes: ProjectsNode[] = windowWorkspaces().map((root) => ({
        type: "workspace" as const,
        root,
        name: workspace.manifest(root)?.name ?? path.basename(root),
        inWindow: true,
      }));
      for (const listed of listProjects()) {
        if (nodes.some((other) => other.type === "workspace" && same(other.root, listed.root))) {
          continue;
        }
        nodes.push(
          listed.kind === "workspace"
            ? { type: "workspace", root: listed.root, name: listed.name, inWindow: false }
            : { type: "project", project: listed },
        );
      }
      return nodes;
    }
    if (node.type === "workspace") {
      const found = (await workspace.describe(node.root)).description?.workspace;
      if (!found) {
        return [];
      }
      return groups(found).flatMap((group): ProjectsNode[] =>
        group.name
          ? [{ type: "group", workspace: found, name: group.name, members: group.members }]
          : group.members.map((member) => ({ type: "member" as const, workspace: found, member })),
      );
    }
    if (node.type === "group") {
      return node.members.map((member) => ({ type: "member" as const, workspace: node.workspace, member }));
    }
    return [];
  }

  getTreeItem(node: ProjectsNode): vscode.TreeItem {
    switch (node.type) {
      case "project": {
        const { project } = node;
        const item = new vscode.TreeItem(project.name);
        item.iconPath = new vscode.ThemeIcon(project.kind === "slides" ? "preview" : "device-camera-video");
        item.description = project.kind;
        item.tooltip = project.root;
        item.resourceUri = vscode.Uri.file(project.root);
        item.contextValue = "gaanim.project";
        item.command = { title: "Open", command: "gaanim.openProjectAt", arguments: [project.root] };
        return item;
      }
      case "workspace": {
        const item = new vscode.TreeItem(
          node.name,
          node.inWindow ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `workspace:${node.root}`;
        item.iconPath = new vscode.ThemeIcon("folder-library");
        const found = workspace.at(node.root);
        const known = workspace.known(node.root);
        const report = check.lastWorkspaceReport.get(node.root);
        item.description = found ? `workspace · ${count(found.members.length)}` : known?.error ? "workspace · cannot be read" : "workspace";
        item.tooltip = new vscode.MarkdownString(
          [`**${node.name}** · workspace`, `\`${node.root}\``, known?.error ? `$(error) ${known.error}` : "", report ? `Last check: ${report.summary}` : ""]
            .filter(Boolean)
            .join("\n\n"),
          true,
        );
        item.contextValue = "gaanim.workspace";
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group:${node.workspace.root}:${node.name}`;
        item.iconPath = new vscode.ThemeIcon("folder");
        item.description = count(node.members.length);
        item.contextValue = "gaanim.group";
        return item;
      }
      case "member": {
        const { member } = node;
        const item = new vscode.TreeItem(member.name);
        item.id = `member:${member.root}`;
        const active = workspace.activeMember(node.workspace.root);
        const isActive = Boolean(active && same(active, member.root));
        const report = check.lastReport.get(check.memberAsProject(member).root);
        if (member.error) {
          item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
          item.description = `${member.path} · invalid`;
        } else {
          const failedCheck = report?.status === "error";
          item.iconPath = new vscode.ThemeIcon(
            failedCheck ? "error" : MEMBER_ICONS[member.kind ?? "video"],
            failedCheck ? new vscode.ThemeColor("errorForeground") : report?.status === "warning" ? new vscode.ThemeColor("editorWarning.foreground") : undefined,
          );
          item.description = `${member.path}${isActive ? " · active" : ""}`;
        }
        item.tooltip = new vscode.MarkdownString(
          [
            `**${label(member)}** · ${member.kind ?? "invalid"}`,
            `\`${member.root}\``,
            member.error ? `$(error) ${member.error}` : "",
            isActive ? "The workspace's shared files run as this member." : "",
            report ? `Last check: ${report.status === "pass" ? "passed" : report.summary}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          true,
        );
        item.resourceUri = vscode.Uri.file(member.entry ?? path.join(member.root, "gaanim.toml"));
        item.contextValue = member.error ? "gaanim.member.invalid" : "gaanim.member";
        item.command = { title: "Open", command: "gaanim.member.open", arguments: [node] };
        return item;
      }
    }
  }
}
