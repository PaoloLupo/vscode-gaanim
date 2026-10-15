// The Gaanim side bar: the project's timeline and the projects folder.

import * as path from "node:path";
import * as vscode from "vscode";
import { clock } from "./core/clock";
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

export class ProjectsTree implements vscode.TreeDataProvider<Project & { mtime: number }> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  getChildren(): (Project & { mtime: number })[] {
    return listProjects();
  }

  getTreeItem(project: Project & { mtime: number }): vscode.TreeItem {
    const item = new vscode.TreeItem(project.name);
    item.iconPath = new vscode.ThemeIcon(project.kind === "slides" ? "preview" : "device-camera-video");
    item.description = project.kind;
    item.tooltip = project.root;
    item.resourceUri = vscode.Uri.file(project.root);
    item.command = { title: "Open", command: "gaanim.openProjectAt", arguments: [project.root] };
    return item;
  }
}
