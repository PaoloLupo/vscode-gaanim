// Gaanim for VS Code: the commands, providers and views, wired to the editor's events.

import * as path from "node:path";
import * as vscode from "vscode";
import * as check from "./check";
import * as cli from "./cli";
import { pythonString, receiver } from "./core/symbols";
import { secondsArg } from "./core/clock";
import * as decorations from "./decorations";
import * as docs from "./docs";
import { doctor } from "./doctor";
import { openAt, UriHandler } from "./editorLink";
import { disposeEvents, previewChanged, scriptChanged, timelineChanged, workspaceChanged } from "./events";
import * as exporter from "./exporter";
import * as inspect from "./inspect";
import * as live from "./live";
import * as navigation from "./navigation";
import { isScript } from "./narration";
import { nudge } from "./nudge";
import * as preview from "./preview";
import { findRoot, forgetRoots, forgetSymbols, loadProject, projectForDocument, projectForFile, rememberProject, currentProject } from "./project";
import * as projects from "./projects";
import {
  assetDiagnostics,
  CodeActions,
  CodeLenses,
  Completion,
  DocumentSymbols,
  Hover,
  InlayHints,
  publishAssets,
  SELECTOR,
} from "./providers";
import * as python from "./python";
import { Scrubber } from "./scrubber";
import * as scriptView from "./scriptView";
import * as statusBar from "./statusBar";
import * as takes from "./takeInspector";
import { EntryNode, ProjectsNode, ProjectsTree, TimelineTree } from "./views";
import type { Workspace } from "./core/workspace";
import * as workspace from "./workspace";

/** Brings an editor to a line of a document. */
async function focus(uri: vscode.Uri, line: number): Promise<vscode.TextEditor | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === uri.toString()) {
    if (editor.selection.active.line !== line - 1) {
      const position = new vscode.Position(line - 1, editor.document.lineAt(line - 1).firstNonWhitespaceCharacterIndex);
      editor.selection = new vscode.Selection(position, position);
    }
    return editor;
  }
  return openAt(uri.fsPath, line);
}

async function input(title: string, prompt: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title,
    prompt,
    validateInput: (text) => (text.trim() === "" ? "A name, please" : undefined),
  });
  return value?.trim() || undefined;
}

const SLIDES = new Set(["segment", "section", "voiceover"]);
const STOPS = new Set(["stop"]);

function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand("setContext", key, value);
}

/** The workspace whose own folders (a shared module, its manifest) hold a file. */
function ownWorkspace(file: string): string | undefined {
  const root = findRoot(path.dirname(file));
  return root && workspace.isRoot(root) ? root : undefined;
}

function updateContext(): void {
  const editor = vscode.window.activeTextEditor;
  const file = editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined;
  const project = (editor && projectForDocument(editor.document)) ?? currentProject();
  // A workspace's shared module counts: its commands ask which member to run as.
  const shared = Boolean(file && editor?.document.languageId === "python" && ownWorkspace(file));
  setContext("gaanim.inProject", Boolean(project) || shared);
  const targets = [file, ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)];
  setContext("gaanim.inWorkspace", targets.some((target) => target && workspace.rootFor(target)));
  const running = project ? preview.status.get(project.root) : undefined;
  setContext("gaanim.previewRunning", Boolean(running));
  setContext("gaanim.following", Boolean(project && preview.following.has(project.root)));
  setContext("gaanim.live", Boolean(project && live.active(project.root)));
}

/** What the integration tests read of the extension's state. */
export interface GaanimApi {
  previews: typeof preview.status;
  timeline: typeof inspect.cached;
  reports: typeof check.lastReport;
  workspaceReports: typeof check.lastWorkspaceReport;
  activeMember: typeof workspace.activeMember;
  projectFor: typeof projectForFile;
  environment: typeof python.environment;
  projects: ProjectsTree;
}

export function activate(context: vscode.ExtensionContext): GaanimApi {
  const subscriptions = context.subscriptions;
  workspace.restore(context.workspaceState);
  // A command that needs a member in a workspace's shared file asks which
  // one and runs again: it knows how from here.
  const command = (id: string, run: (...args: never[]) => unknown) =>
    subscriptions.push(
      vscode.commands.registerCommand(id, (...args: unknown[]) => {
        workspace.setRetry(() => vscode.commands.executeCommand(id, ...args));
        try {
          return (run as (...args: unknown[]) => unknown)(...args);
        } finally {
          workspace.setRetry(undefined);
        }
      }),
    );

  subscriptions.push(vscode.window.registerUriHandler(new UriHandler()));

  // Language features.
  subscriptions.push(
    vscode.languages.registerInlayHintsProvider(SELECTOR, new InlayHints()),
    vscode.languages.registerCodeLensProvider(SELECTOR, new CodeLenses()),
    vscode.languages.registerHoverProvider(SELECTOR, new Hover()),
    vscode.languages.registerCodeActionsProvider(SELECTOR, new CodeActions(), { providedCodeActionKinds: CodeActions.kinds }),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, new DocumentSymbols(), { label: "Gaanim" }),
    vscode.languages.registerCompletionItemProvider(SELECTOR, new Completion(), ...Completion.triggers),
    check.diagnostics,
    assetDiagnostics,
    takes.diagnostics,
    cli.log,
  );

  // Views.
  const timelineTree = new TimelineTree();
  const timelineView = vscode.window.createTreeView("gaanim.timeline", { treeDataProvider: timelineTree, showCollapseAll: true });
  timelineTree.attach(timelineView);
  const projectsTree = new ProjectsTree();
  const scrubber = new Scrubber();
  subscriptions.push(
    timelineView,
    vscode.window.registerTreeDataProvider("gaanim.projects", projectsTree),
    vscode.window.registerWebviewViewProvider("gaanim.scrubber", scrubber, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // Projects.
  command("gaanim.new", (kind?: string, name?: string) => projects.newProject(context, kind, name));
  command("gaanim.openProject", () => projects.pickProject(context));
  command("gaanim.openProjectAt", (root: string) => projects.openProject(context, root));
  command("gaanim.refreshProjects", () => {
    forgetRoots();
    workspace.invalidate();
    projectsTree.refresh();
  });

  // Workspaces.
  const memberRoot = async (node?: ProjectsNode): Promise<Workspace | undefined> =>
    node && node.type !== "project" ? (node.type === "workspace" ? await workspace.load(node.root) : node.workspace) : await workspace.current();
  command("gaanim.newWorkspace", (name?: string) => projects.newWorkspace(context, name));
  command("gaanim.newMember", (kind?: string, root?: string, name?: string) => projects.newMember(context, root, kind, name));
  command("gaanim.checkWorkspace", async (node?: ProjectsNode) => {
    const found = await memberRoot(node);
    if (found) {
      await check.runWorkspace(found, node?.type === "group" ? node.members.map((member) => member.path) : undefined);
    }
  });
  command("gaanim.exportWorkspace", async (node?: ProjectsNode | string) => {
    const found = await memberRoot(typeof node === "string" ? undefined : node);
    if (found) {
      await exporter.exportWorkspace(found, typeof node === "string" ? node : undefined, typeof node === "object" && node.type === "group" ? node.members : undefined);
    }
  });
  command("gaanim.useMember", async () => {
    const found = await workspace.current();
    const member = found && (await workspace.pickMember(found, `Run the shared files of ${found.name} as`, true));
    if (found && member) {
      workspace.use(found.root, member.root);
    }
  });
  command("gaanim.workspace.newVideo", (node: ProjectsNode) => node.type === "workspace" && projects.newMember(context, node.root, "video"));
  command("gaanim.workspace.newSlides", (node: ProjectsNode) => node.type === "workspace" && projects.newMember(context, node.root, "slides"));
  command("gaanim.member.open", async (node: ProjectsNode) => {
    if (node.type === "member") {
      await projects.openMember(context, node.workspace.root, node.member);
    }
  });
  command("gaanim.member.use", (node: ProjectsNode) => node.type === "member" && workspace.use(node.workspace.root, node.member.root));
  command("gaanim.member.check", (node: ProjectsNode) => node.type === "member" && check.runWorkspace(node.workspace, [node.member.path]));
  command("gaanim.member.export", async (node: ProjectsNode) => {
    const project = node.type === "member" ? loadProject(node.member.root) : undefined;
    if (project) {
      await exporter.exportPreset(undefined, [], project);
    }
  });

  // Preview.
  command("gaanim.preview", () => preview.launch());
  command("gaanim.previewHere", () => preview.here());
  command("gaanim.previewOnly", () => preview.only());
  command("gaanim.follow", () => preview.follow());
  command("gaanim.live", () => live.toggle());
  command("gaanim.loop", () => preview.toggleLoop());
  command("gaanim.loopPick", () => preview.loopPick());
  command("gaanim.seek", (target?: string | number) => (target === undefined ? preview.seekPick() : preview.seek(target)));
  command("gaanim.play", () => preview.play(true));
  command("gaanim.pause", () => preview.play(false));
  command("gaanim.togglePlay", () => preview.togglePlay());
  command("gaanim.present", () => preview.presentPick());
  command("gaanim.presentHere", () => preview.here(true));
  command("gaanim.stop", () => preview.stop());

  // Checks and exports.
  command("gaanim.check", () => check.run());
  command("gaanim.export", (preset?: string) => exporter.exportPreset(preset));
  command("gaanim.exportSlide", (preset?: string) => exporter.exportSlide(preset));
  command("gaanim.still", () => exporter.stillHere());
  command("gaanim.stillPick", () => exporter.stillPick());

  // Structure and script.
  command("gaanim.outline", () => navigation.outline());
  command("gaanim.timeline", () => navigation.timeline());
  command("gaanim.refreshTimeline", () => {
    const project = currentProject();
    if (project) {
      inspect.invalidate(project.root);
      void inspect.get(project).then(() => timelineTree.refresh());
    }
    timelineTree.refresh();
  });
  command("gaanim.script", () => scriptView.command());
  command("gaanim.scriptGoto", () => scriptView.jump());
  command("gaanim.scriptToCode", () => scriptView.scriptToCode());
  command("gaanim.nextSlide", () => preview.moveTo(1, SLIDES));
  command("gaanim.prevSlide", () => preview.moveTo(-1, SLIDES));
  command("gaanim.nextStop", () => preview.moveTo(1, STOPS));
  command("gaanim.prevStop", () => preview.moveTo(-1, STOPS));
  command("gaanim.nudgeUp", () => nudge(1));
  command("gaanim.nudgeDown", () => nudge(-1));

  // Help.
  command("gaanim.docs", (query?: string) => docs.search(query));
  command("gaanim.api", (name?: string) => docs.api(name));
  command("gaanim.log", () => cli.log.show());
  command("gaanim.doctor", () => doctor());
  command("gaanim.useProjectPython", () => python.useProjectPython());

  // Lenses and code actions.
  command("gaanim.lens.preview", async (uri: vscode.Uri, line: number) => {
    const editor = await focus(uri, line);
    await preview.here(false, editor);
  });
  command("gaanim.lens.still", async (uri: vscode.Uri, line: number) => {
    const editor = await focus(uri, line);
    await exporter.stillHere(editor);
  });
  command("gaanim.lens.script", async (uri: vscode.Uri, line: number) => {
    await focus(uri, line);
    await scriptView.jump();
  });
  command("gaanim.lens.seek", (name: string) => preview.seek(name));
  command("gaanim.lens.loop", (name: string) => preview.loop(name === "off" ? "off" : name));
  command("gaanim.action.exportSlide", async (uri: vscode.Uri, line: number) => {
    const editor = await focus(uri, line);
    await exporter.exportSlide("draft", editor);
  });
  command("gaanim.action.nameStop", async (uri: vscode.Uri, line: number) => {
    const editor = await focus(uri, line);
    const name = editor && (await input("Name this stop", "The stop's name, for the script's [stop name] and exports"));
    if (!editor || !name) {
      return;
    }
    const text = editor.document.lineAt(line - 1).text;
    const match = /\.stop\(\s*\)/.exec(text);
    if (match) {
      const start = match.index;
      await editor.edit((builder) =>
        builder.replace(new vscode.Range(line - 1, start, line - 1, start + match[0].length), `.stop(${pythonString(name)})`),
      );
    }
  });
  command("gaanim.action.addMarker", async (uri: vscode.Uri, line: number) => {
    const editor = await focus(uri, line);
    const name = editor && (await input("Add a marker", "The marker's name, for --from, --to and --frame"));
    if (!editor || !name) {
      return;
    }
    const lines = editor.document.getText().split(/\r?\n/);
    const indent = /^\s*/.exec(lines[line - 1] ?? "")![0];
    const marker = `${indent}${receiver(lines, line)}.marker(${pythonString(name)})`;
    const end = editor.document.lineAt(line - 1).range.end;
    const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    await editor.edit((builder) => builder.insert(end, eol + marker));
    const position = new vscode.Position(line, indent.length);
    editor.selection = new vscode.Selection(position, position);
  });

  // Timeline view entries.
  const entryGo = async (node: EntryNode) => {
    const project = currentProject();
    if (node.entry.file && node.entry.line) {
      await openAt(node.entry.file, node.entry.line);
    }
    if (project && !node.outline && (node.entry.seek.segment || node.entry.seek.time !== undefined)) {
      preview.send(project, node.entry.seek);
    }
  };
  command("gaanim.entry.go", entryGo);
  command("gaanim.entry.preview", async (node: EntryNode) => {
    const project = currentProject();
    if (!project) {
      return;
    }
    if (!node.outline && node.entry.seek.segment) {
      await preview.seek(node.entry.seek.segment, project);
    } else if (!node.outline && node.entry.seek.time !== undefined) {
      await preview.seek(node.entry.seek.time, project);
    } else if (node.entry.file && node.entry.line) {
      await preview.here(false, await openAt(node.entry.file, node.entry.line));
    }
  });
  command("gaanim.entry.loop", (node: EntryNode) => preview.loop(node.entry.segment ?? node.entry.label));
  command("gaanim.entry.still", async (node: EntryNode) => {
    const project = currentProject();
    if (project && !node.outline) {
      const label = node.entry.kind === "segment" || node.entry.kind === "section" ? node.entry.label : `${node.entry.kind}-${node.entry.label}`;
      const output = `${project.outputDir}/${project.name}-${label.replace(/[^\w.-]/g, "_")}.png`;
      const frame = node.entry.kind === "segment" || node.entry.kind === "section" ? node.entry.segment! : secondsArg(node.entry.time);
      await exporter.run(project, output, ["--frame", (await cli.caps()).names ? frame : secondsArg(node.entry.time)]);
    } else if (node.entry.file && node.entry.line) {
      await exporter.stillHere(await openAt(node.entry.file, node.entry.line));
    }
  });
  command("gaanim.entry.exportSlide", async (node: EntryNode) => {
    if (node.entry.file && node.entry.line) {
      await exporter.exportSlide(undefined, await openAt(node.entry.file, node.entry.line));
    }
  });
  command("gaanim.entry.script", async (node: EntryNode) => {
    if (node.entry.file && node.entry.line) {
      await openAt(node.entry.file, node.entry.line);
      await scriptView.jump();
    }
  });

  // Editor events.
  const assetTimers = new Map<string, NodeJS.Timeout>();
  const refreshDiagnosticsSoon = (document: vscode.TextDocument) => {
    const key = document.uri.toString();
    clearTimeout(assetTimers.get(key));
    assetTimers.set(
      key,
      setTimeout(() => {
        assetTimers.delete(key);
        publishAssets(document);
        void takes.publish(document);
      }, 300),
    );
  };
  const onEditor = (editor: vscode.TextEditor | undefined) => {
    updateContext();
    statusBar.refreshPreview();
    statusBar.refreshCursor(editor);
    statusBar.refreshMember(editor);
    if (!editor) {
      return;
    }
    const project = projectForDocument(editor.document);
    const file = editor.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined;
    if (file && project && project.kind !== "script" && !ownWorkspace(file)) {
      // A member's own file: its member becomes the one the shared files run as.
      workspace.onFile(file, project.root);
    } else if (file && ownWorkspace(file)) {
      // What the workspace shares, for its own files' assets and completion.
      void workspace.describe(file);
    }
    if (project) {
      rememberProject(project);
      timelineTree.refresh();
      scrubber.post();
      if (editor.document.languageId === "python") {
        void python.checkProject(project, file);
        if (!inspect.cached(project) && cli.executable(true)) {
          inspect.refreshSoon(project, 0);
        }
      }
    }
    scriptView.decorate(editor);
  };
  subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(onEditor),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== vscode.window.activeTextEditor) {
        return;
      }
      preview.onCursor(event.textEditor);
      scriptView.followCursor(event.textEditor);
      statusBar.refreshCursor(event.textEditor);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        scriptView.decorate(editor);
      }
      for (const root of preview.status.keys()) {
        decorations.refresh(root);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      live.onChange(event);
      const document = event.document;
      if (document.languageId === "python" && event.contentChanges.length > 0) {
        refreshDiagnosticsSoon(document);
      } else if (document.languageId === "markdown") {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === document) {
            scriptView.decorate(editor);
          }
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      publishAssets(document);
      void takes.publish(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      assetDiagnostics.delete(document.uri);
      takes.diagnostics.delete(document.uri);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file" || !/\.(py|md|toml)$/.test(document.fileName)) {
        return;
      }
      const root = ownWorkspace(document.uri.fsPath);
      if (root && workspace.isSharedFile(root, document.uri.fsPath)) {
        // Every member imports it: every member's timeline is stale.
        for (const member of workspace.at(root)?.members ?? []) {
          inspect.invalidate(member.root);
        }
      }
      const project = projectForDocument(document);
      if (!project) {
        return;
      }
      inspect.invalidate(project.root);
      if (!live.saving.has(document.uri.toString())) {
        check.onSave(project);
      }
      if (document.languageId === "python") {
        inspect.refreshSoon(project);
        void takes.publish(document);
      } else if (document.languageId === "markdown" && isScript(project, document.uri.fsPath)) {
        scriptChanged.fire(project.root);
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.languageId === "python") {
            void takes.publish(editor.document);
          }
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("gaanim.path")) {
        cli.resetCaps();
      }
      if (event.affectsConfiguration("gaanim.outline")) {
        forgetSymbols();
      }
      if (event.affectsConfiguration("gaanim.projectsDir")) {
        projectsTree.refresh();
      }
      if (event.affectsConfiguration("gaanim")) {
        timelineChanged.fire("");
        for (const editor of vscode.window.visibleTextEditors) {
          scriptView.decorate(editor);
          publishAssets(editor.document);
          void takes.publish(editor.document);
        }
      }
    }),
  );

  // Any gaanim.toml written may change projects, members and what they share.
  const manifests = vscode.workspace.createFileSystemWatcher("**/gaanim.toml");
  const manifestChanged = () => {
    forgetRoots();
    workspace.invalidate();
    updateContext();
    projectsTree.refresh();
  };
  manifests.onDidCreate(manifestChanged);
  manifests.onDidChange(manifestChanged);
  manifests.onDidDelete(manifestChanged);
  subscriptions.push(manifests);

  // What `gaanim project` said arrived, or the active member changed.
  let workspaceTimer: NodeJS.Timeout | undefined;
  subscriptions.push(
    workspaceChanged.event(() => {
      clearTimeout(workspaceTimer);
      workspaceTimer = setTimeout(() => {
        updateContext();
        statusBar.refreshPreview();
        statusBar.refreshMember();
        projectsTree.refresh();
        // A shared module's times, lenses and hints come from the active member.
        timelineChanged.fire("");
        for (const editor of vscode.window.visibleTextEditors) {
          publishAssets(editor.document);
        }
      }, 50);
    }),
  );

  // What the preview and the timeline say.
  const shownSlide = new Map<string, string>();
  subscriptions.push(
    previewChanged.event((root) => {
      decorations.refresh(root);
      statusBar.refreshPreview();
      updateContext();
      const running = preview.status.get(root);
      const playhead = running?.playhead;
      if (running && playhead?.segment) {
        const signature = `${playhead.segment}\0${playhead.stop ?? ""}`;
        if (shownSlide.get(root) !== signature) {
          shownSlide.set(root, signature);
          scriptView.showSlide(running.project, playhead.segment, playhead.stop);
        }
      } else if (!running) {
        shownSlide.delete(root);
      }
    }),
    timelineChanged.event((root) => {
      statusBar.refreshCursor();
      if (root) {
        decorations.refresh(root);
      }
    }),
    scriptChanged.event(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        scriptView.decorate(editor);
      }
    }),
  );

  subscriptions.push({
    dispose() {
      cli.stopAll();
      decorations.dispose();
      scriptView.dispose();
      statusBar.dispose();
      disposeEvents();
    },
  });

  for (const document of vscode.workspace.textDocuments) {
    publishAssets(document);
    void takes.publish(document);
  }
  onEditor(vscode.window.activeTextEditor);
  void projects.openPending(context);
  return {
    previews: preview.status,
    timeline: inspect.cached,
    reports: check.lastReport,
    workspaceReports: check.lastWorkspaceReport,
    activeMember: workspace.activeMember,
    projectFor: projectForFile,
    environment: python.environment,
    projects: projectsTree,
  };
}

export function deactivate(): void {
  cli.stopAll();
}
