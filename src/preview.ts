// The live preview and presenting.
//
// With a Gaanim that has `--listen`, the preview runs with `--listen stdio`:
// the extension moves it to the line under the cursor without restarting it,
// can keep it following the cursor, and hears where it rests (`playhead`),
// which it marks in the code and in the narration script. Older versions
// restart the preview with `--from`.

import * as vscode from "vscode";
import * as check from "./check";
import * as cli from "./cli";
import { config } from "./config";
import { fromText } from "./core/check";
import { pathKey, pointAt, segmentAt, Timeline } from "./core/timeline";
import { editorCommand } from "./editorLink";
import { previewChanged } from "./events";
import * as inspect from "./inspect";
import { currentProject, documentSymbols, Project, projectForDocument, projectSymbols, rememberProject, requireProject, slideAtCursor } from "./project";

export interface LaunchOptions {
  present?: boolean;
  /** Segment or Section key to start at. */
  from?: string;
  /** Only these segments or Section keys. */
  sections?: string[];
  /** Rest at the instant of this line once ready. */
  follow?: { file: string; line: number };
  /** Commands to send once ready. */
  queue?: Command[];
  duration?: string;
  monitor?: number;
  args?: string[];
}

export type Command =
  | { cmd: "seek"; time?: number; segment?: string; stop?: string }
  | { cmd: "follow"; file: string; line: number }
  | { cmd: "play" }
  | { cmd: "pause" }
  | { cmd: "loop"; segment?: string; start?: number; end?: number }
  | { cmd: "unloop" };

export interface Playhead {
  time: number;
  segment?: string;
  /** `""` at an unnamed stop, undefined before the first stop. */
  stop?: string;
  playing: boolean;
  /** `[start, end]` while the preview loops a range. */
  loop?: [number, number];
}

export interface PreviewStatus {
  state: "starting" | "reloading" | "ready" | "failed";
  detail?: string;
  key: string;
  project: Project;
  /** The preview takes commands. */
  listen: boolean;
  present: boolean;
  duration?: number;
  playhead?: Playhead;
  /** Commands waiting for the scene to be ready. */
  queue: Command[];
  /** Its `ready` events carry the timeline. */
  sendsTimeline: boolean;
}

/** Previews by project root. */
export const status = new Map<string, PreviewStatus>();

/** Projects whose preview follows the cursor. */
export const following = new Set<string>();

/** Arguments of each running process, to spot changes. */
const launched = new Map<string, string>();

inspect.setPreviewSends((root) => {
  const preview = status.get(root);
  return Boolean(preview && preview.sendsTimeline && preview.state !== "failed" && cli.running(preview.key));
});

function changed(project: Project): void {
  previewChanged.fire(project.root);
}

function escapeCommas(name: string): string {
  return name.replace(/,/g, "\\,");
}

/**
 * The path the preview knows a file by: the timeline's own spelling when it
 * names the same file (drive letter case and slashes differ on Windows),
 * else the file with an upper-case drive letter, as Python names it.
 */
export function previewPath(project: Project, file: string): string {
  const data = inspect.cached(project);
  if (data) {
    const wanted = pathKey(file);
    const named = [
      ...data.segments.flatMap((segment) => [segment.file, ...(segment.stops ?? []).map((stop) => stop.file)]),
      ...(data.plays ?? []).map((play) => play.file),
      data.script,
    ].find((candidate) => candidate && pathKey(candidate) === wanted);
    if (named) {
      return named;
    }
  }
  return file.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function cursorLine(project: Project, editor: vscode.TextEditor): { file: string; line: number } {
  return { file: previewPath(project, editor.document.uri.fsPath), line: editor.selection.active.line + 1 };
}

/** Whether a preview of the project runs and takes commands. */
export function listening(project: Project): boolean {
  const preview = status.get(project.root);
  return Boolean(preview && preview.listen && cli.running(preview.key));
}

/** Sends a command to the project's preview, or queues it until the scene is ready. */
export function send(project: Project, command: Command): boolean {
  const preview = status.get(project.root);
  if (!preview || !preview.listen || !cli.running(preview.key)) {
    return false;
  }
  if (preview.state === "ready" || preview.state === "failed") {
    return cli.send(preview.key, command);
  }
  preview.queue.push(command);
  return true;
}

async function canListen(): Promise<boolean> {
  return config.preview.listen() && (await cli.caps()).listen;
}

export async function launch(options: LaunchOptions = {}, project: Project | undefined = requireProject()): Promise<void> {
  if (!project) {
    return;
  }
  rememberProject(project);
  const caps = await cli.caps();
  const listen = config.preview.listen() && caps.listen;
  const args: string[] = [];
  if (options.present) {
    args.push("--present");
    const duration = options.duration ?? config.present.duration();
    if (duration) {
      args.push("--duration", duration);
    }
    const monitor = options.monitor ?? config.present.monitor();
    if (monitor !== undefined) {
      args.push("--monitor", String(monitor));
    }
  }
  args.push(...config.preview.args());
  if (options.from) {
    args.push("--from", options.from);
  }
  if (options.sections && options.sections.length > 0) {
    args.push("--sections", options.sections.map(escapeCommas).join(","));
  }
  args.push(...(options.args ?? []));
  if (listen) {
    args.push("--listen", "stdio");
  }
  if (caps.json) {
    args.push("--message-format", "json");
  }
  args.push(project.target);

  const key = `${options.present ? "present" : "preview"}:${project.root}`;
  const signature = args.join("\0");
  const follow: Command | undefined = options.follow ? { cmd: "follow", ...options.follow } : undefined;
  if (cli.running(key)) {
    if (launched.get(key) === signature) {
      if (follow && send(project, follow)) {
        return;
      }
      for (const command of options.queue ?? []) {
        send(project, command);
      }
      if (!follow && !options.queue?.length) {
        void vscode.window.showInformationMessage(
          options.present ? "Already presenting." : "The preview is open; it reloads when you save.",
        );
      }
      return;
    }
    cli.stop(key);
  }
  launched.set(key, signature);
  const scope = options.from
    ? ` from ${options.from}`
    : options.sections
      ? ` ${options.sections.join(", ")}`
      : options.follow
        ? ` at line ${options.follow.line}`
        : "";
  vscode.window.setStatusBarMessage(`${options.present ? "Presenting" : "Previewing"} ${project.name}${scope}`, 3000);

  const preview: PreviewStatus = {
    state: "starting",
    key,
    project,
    listen,
    present: options.present === true,
    queue: [...(follow ? [follow] : []), ...(options.queue ?? [])],
    sendsTimeline: false,
  };
  status.set(project.root, preview);
  changed(project);
  let pending: string[] = []; // Lines since the last reload: a traceback, prints.
  const set = (state: PreviewStatus["state"], detail?: string) => {
    preview.state = state;
    preview.detail = detail;
    changed(project);
  };
  const ready = (detail?: string) => {
    pending = [];
    const wasFailed = preview.state === "failed";
    set("ready", detail);
    for (const command of preview.queue) {
      cli.send(key, command);
    }
    preview.queue = [];
    if (wasFailed || check.lastReport.get(project.root)?.status === "error") {
      // The script runs again: the old error is gone; a check confirms the rest.
      check.clear(project);
      void check.run(project, true);
    }
  };
  const failed = (message: string, file?: string, line?: number) => {
    const report = file
      ? {
          status: "error" as const,
          summary: message,
          problems: [{ file, line: line ?? 1, column: 1, severity: "error" as const, text: message }],
        }
      : fromText([`  ✗ python    ${message}`, ...pending], check.locateContext(project));
    if (report.problems.length === 0) {
      report.problems.push({ file: project.entry, line: 1, column: 1, severity: "error", text: message });
    }
    check.publish(project, report);
    check.lastReport.set(project.root, report);
    pending = [];
    set("failed", report.summary || message);
    const live = liveActive(project.root);
    if (!(live && config.live.quiet())) {
      void vscode.window.showErrorMessage(`✗ ${report.summary || message}`, "Go to Error").then((choice) => {
        const problem = report.problems[0];
        if (choice && problem) {
          void vscode.commands.executeCommand(
            "vscode.open",
            vscode.Uri.file(problem.file),
            { selection: new vscode.Range(problem.line - 1, 0, problem.line - 1, 0) },
          );
        }
      });
    }
  };

  const job = cli.run(args, {
    cwd: project.root,
    key,
    stdin: listen,
    env: config.preview.editor() ? { GAANIM_EDITOR: editorCommand() } : undefined,
    onJson: (object) => {
      const event = object.event as string | undefined;
      const kind = object.type as string | undefined;
      if (event === "reload" || (kind === "reload" && object.phase === "start")) {
        pending = [];
        set("reloading", typeof object.cause === "string" ? object.cause : undefined);
      } else if (event === "ready") {
        preview.duration = typeof object.duration === "number" ? object.duration : undefined;
        // Newer Gaanim sends the scene's timeline with each `ready`, the same
        // object `gaanim inspect --json` prints: no second run needed.
        const timeline = object.timeline as Timeline | null | undefined;
        if (timeline && typeof timeline === "object" && Array.isArray(timeline.segments)) {
          preview.sendsTimeline = true;
          inspect.store(project, timeline);
        }
        ready(preview.duration !== undefined ? `${preview.duration.toFixed(1)} s` : undefined);
      } else if (kind === "reload" && object.phase === "end" && !listen) {
        ready(typeof object.seconds === "number" ? `reloaded in ${object.seconds.toFixed(2)} s` : undefined);
      } else if (event === "failed") {
        failed(
          (object.message as string) || "Script failed",
          (object.file as string | null) ?? undefined,
          (object.line as number | null) ?? undefined,
        );
      } else if (kind === "message" && object.level === "error" && object.label === "python" && !listen) {
        failed(
          (object.message as string) || "Script failed",
          (object.file as string | null) ?? undefined,
          (object.line as number | null) ?? undefined,
        );
      } else if (event === "playhead") {
        const loop = Array.isArray(object.loop) && object.loop.length === 2 ? (object.loop as [number, number]) : undefined;
        preview.playhead = {
          time: typeof object.time === "number" ? object.time : 0,
          segment: (object.segment as string | null) ?? undefined,
          stop: (object.stop as string | null) ?? undefined,
          playing: object.playing === true,
          loop,
        };
        changed(project);
      } else if (event === "error") {
        let message = (object.message as string) || "The preview could not do that";
        if (message.includes("unknown variant `loop`") || message.includes("unknown variant `unloop`")) {
          message = "Looping from the editor needs a newer Gaanim (gaanim update); press L in the preview meanwhile.";
        }
        void vscode.window.showWarningMessage(message);
      }
    },
    onLine: (line) => {
      if (caps.json) {
        pending.push(line);
        return;
      }
      // Older versions: read the status lines meant for people.
      const match = /^\s\s\S+\s+(\S+)\s*(.*)$/.exec(line);
      const label = match?.[1];
      const text = match?.[2] ?? "";
      if (label === "reload" || label === "watch") {
        pending = [];
        set(label === "reload" ? "reloading" : "starting", text);
      } else if (label === "ready") {
        ready(text);
      } else if (label === "python" && line.includes("✗")) {
        failed(text);
      } else {
        pending.push(line);
      }
    },
    onExit: (code, lines, objects) => {
      if (status.get(project.root) === preview) {
        status.delete(project.root);
        following.delete(project.root);
      }
      if (launched.get(key) === signature && !cli.running(key)) {
        launched.delete(key);
      }
      changed(project);
      if (code === 0 || job?.stopped) {
        return;
      }
      // It never got ready: the output says why.
      if (preview.state !== "ready") {
        const result = check.report(project, lines, objects);
        if (result.problems.length > 0) {
          check.publish(project, result);
          void vscode.window.showErrorMessage(`✗ ${result.problems[0].text} (exit ${code})`);
          return;
        }
      }
      void vscode.window.showWarningMessage(`gaanim exited with ${code}.`, "Show Log").then((choice) => {
        if (choice) {
          cli.log.show(true);
        }
      });
    },
  });
  if (!job) {
    status.delete(project.root);
    changed(project);
  }
}

let liveActive: (root: string) => boolean = () => false;

/** Live mode tells the preview when failures should stay quiet. */
export function setLiveCheck(check: (root: string) => boolean): void {
  liveActive = check;
}

/** The slide name under the cursor, or undefined with a message. */
function slideName(editor: vscode.TextEditor | undefined): string | undefined {
  const name = editor && slideAtCursor(editor).segment?.name;
  if (!name) {
    void vscode.window.showWarningMessage("No segment above the cursor in this file.");
  }
  return name;
}

/** Moves the preview to the instant of the line under the cursor, starting it when it is closed. */
export async function here(present = false, editor = vscode.window.activeTextEditor): Promise<void> {
  const project = editor ? projectForDocument(editor.document) : requireProject();
  if (!project) {
    if (editor) {
      void vscode.window.showWarningMessage("This file is not part of a Gaanim project.");
    }
    return;
  }
  if (!editor || editor.document.languageId !== "python") {
    await launch({ present }, project);
    return;
  }
  const target = cursorLine(project, editor);
  if (!present && send(project, { cmd: "follow", ...target })) {
    return;
  }
  if (await canListen()) {
    await launch({ present, follow: target }, project);
    return;
  }
  const slide = slideName(editor);
  if (slide) {
    await launch({ present, from: slide }, project);
  }
}

/** Previews only the slide under the cursor. */
export async function only(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const project = editor && projectForDocument(editor.document);
  const slide = slideName(editor);
  if (project && slide) {
    await launch({ sections: [slide] }, project);
  }
}

/** The segment around the cursor: from the Python, else from the timeline's instant of the cursor's line. */
export function segmentAtCursor(project: Project, editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) {
    return undefined;
  }
  const name = slideAtCursor(editor).segment?.name;
  if (name) {
    return name;
  }
  const data = inspect.cached(project);
  const point = data && pointAt(data, editor.document.uri.fsPath, editor.selection.active.line + 1);
  return point && data ? segmentAt(data, point.time)?.name : undefined;
}

/** Loops a segment by name, a time range, or stops looping (`off`). */
export async function loop(target: string | { start: number; end: number } | "off" | undefined, project = currentProject()): Promise<void> {
  if (!project) {
    void requireProject();
    return;
  }
  let command: Command;
  if (target === "off") {
    command = { cmd: "unloop" };
  } else if (typeof target === "object") {
    command = { cmd: "loop", start: target.start, end: target.end };
  } else {
    const name = target || segmentAtCursor(project, vscode.window.activeTextEditor);
    if (!name) {
      void vscode.window.showWarningMessage("No segment around the cursor to loop.");
      return;
    }
    command = { cmd: "loop", segment: name };
  }
  if (send(project, command) || command.cmd === "unloop") {
    return;
  }
  if (await canListen()) {
    await launch({ queue: [command] }, project);
  } else {
    void vscode.window.showWarningMessage("Looping from the editor needs a Gaanim with --listen (gaanim update).");
  }
}

/** The segment whose whole range the preview loops, if any. */
export function loopedSegment(project: Project): string | undefined {
  const range = status.get(project.root)?.playhead?.loop;
  const data = range && inspect.cached(project);
  return data?.segments.find((segment) => Math.abs(segment.start - range![0]) < 1e-3 && Math.abs(segment.end - range![1]) < 1e-3)?.name;
}

/** Loops the cursor's segment, or stops looping when the preview loops. */
export async function toggleLoop(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  await loop(status.get(project.root)?.playhead?.loop ? "off" : undefined, project);
}

/** Rests the preview at a time (seconds), or at a segment, Section key or stop by name. */
export async function seek(target: string | number, project = currentProject()): Promise<void> {
  if (!project) {
    void requireProject();
    return;
  }
  let command: Command;
  const seconds = typeof target === "number" ? target : Number(target);
  if (typeof target === "number" || (target.trim() !== "" && !Number.isNaN(seconds))) {
    command = { cmd: "seek", time: seconds };
  } else {
    const isStop = projectSymbols(project).some((symbol) => symbol.kind === "stop" && symbol.name === target);
    command = isStop ? { cmd: "seek", stop: target } : { cmd: "seek", segment: target };
  }
  if (send(project, command)) {
    return;
  }
  if (await canListen()) {
    await launch({ queue: [command] }, project);
  } else {
    void vscode.window.showWarningMessage("Moving the preview needs a Gaanim with --listen (gaanim update).");
  }
}

export function play(playing: boolean, project = currentProject()): void {
  if (project && send(project, { cmd: playing ? "play" : "pause" })) {
    return;
  }
  void vscode.window.showWarningMessage("No preview takes commands; open one with Gaanim: Preview at Cursor.");
}

export function togglePlay(project = currentProject()): void {
  const playing = project ? status.get(project.root)?.playhead?.playing : false;
  play(!playing, project);
}

/** Makes the preview follow the cursor through the code, or stop following. */
export async function follow(on?: boolean): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  if (!(await canListen())) {
    void vscode.window.showWarningMessage("Following the cursor needs a Gaanim with --listen (gaanim update).");
    return;
  }
  const enable = on ?? !following.has(project.root);
  if (enable) {
    following.add(project.root);
    const editor = vscode.window.activeTextEditor;
    if (!listening(project)) {
      const target =
        editor && editor.document.languageId === "python" && projectForDocument(editor.document)?.root === project.root
          ? cursorLine(project, editor)
          : undefined;
      await launch({ follow: target }, project);
    } else if (editor) {
      onCursor(editor, true);
    }
  } else {
    following.delete(project.root);
  }
  vscode.window.setStatusBarMessage(enable ? "The preview follows the cursor" : "The preview no longer follows the cursor", 3000);
  changed(project);
}

let followTimer: NodeJS.Timeout | undefined;
const lastFollowed = new Map<string, string>();

/** When the cursor moves: sends its line to a following preview. */
export function onCursor(editor: vscode.TextEditor, now = false): void {
  if (following.size === 0 || editor.document.languageId !== "python") {
    return;
  }
  const project = projectForDocument(editor.document);
  if (!project || !following.has(project.root)) {
    return;
  }
  const target = cursorLine(project, editor);
  const signature = `${target.file}:${target.line}`;
  if (!now && lastFollowed.get(project.root) === signature) {
    return;
  }
  const deliver = () => {
    if (send(project, { cmd: "follow", ...target })) {
      lastFollowed.set(project.root, signature);
    }
  };
  clearTimeout(followTimer);
  if (now) {
    deliver();
  } else {
    followTimer = setTimeout(deliver, config.preview.followDelay());
  }
}

/** Closes the preview and presentation of the current project. */
export function stop(): void {
  const project = currentProject();
  if (!project) {
    cli.stopAll();
    return;
  }
  let any = false;
  for (const prefix of ["preview:", "present:"]) {
    if (cli.running(prefix + project.root)) {
      any = true;
      cli.stop(prefix + project.root);
    }
  }
  following.delete(project.root);
  changed(project);
  vscode.window.setStatusBarMessage(any ? `Closed ${project.name}` : "Nothing running for this project", 3000);
}

/** Presents with choices: from the start or the cursor, how long, on which monitor. */
export async function presentPick(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const project = (editor && projectForDocument(editor.document)) ?? requireProject();
  if (!project) {
    return;
  }
  const slide = editor && editor.document.languageId === "python" ? slideAtCursor(editor).segment?.name : undefined;
  const where = await vscode.window.showQuickPick(
    [
      { label: "$(debug-start) From the start", value: "start" },
      ...(slide ? [{ label: `$(location) From ${slide}`, description: "the slide at the cursor", value: "here" }] : []),
    ],
    { title: `Present ${project.name}`, placeHolder: "Where to start" },
  );
  if (!where) {
    return;
  }
  const talk = projectSymbols(project).find((symbol) => symbol.kind === "talk")?.target;
  const configured = config.present.duration();
  const durations = [
    ...(configured ? [{ label: configured, description: "gaanim.present.duration", value: configured }] : []),
    ...(talk ? [{ label: `${Math.round(talk / 60)}m`, description: "the scene's slides.target()", value: "" }] : []),
    ...["10m", "20m", "30m", "45m", "1h"].map((value) => ({ label: value, description: "", value })),
    { label: "$(edit) Other…", description: "", value: "other" },
    { label: "No countdown", description: "", value: "none" },
  ];
  const duration = await vscode.window.showQuickPick(durations, { title: `Present ${project.name}`, placeHolder: "Planned length" });
  if (!duration) {
    return;
  }
  let length: string | undefined = duration.value || undefined;
  if (duration.value === "other") {
    length = await vscode.window.showInputBox({
      title: "Planned length",
      prompt: "Like 20m, 1h30m or 900 (seconds)",
      validateInput: (value) => (/^(\d+h)?(\d+m)?(\d+s)?$|^\d+$/.test(value.trim()) && value.trim() ? undefined : "Like 20m, 1h30m or 900"),
    });
    if (!length) {
      return;
    }
  } else if (duration.value === "none") {
    length = undefined;
  }
  const monitorText = await vscode.window.showInputBox({
    title: "Monitor",
    prompt: "Monitor index to present on; leave empty to let the system choose",
    value: config.present.monitor()?.toString() ?? "",
    validateInput: (value) => (value.trim() === "" || /^\d+$/.test(value.trim()) ? undefined : "A monitor index, such as 1"),
  });
  if (monitorText === undefined) {
    return;
  }
  const options: LaunchOptions = {
    present: true,
    duration: length,
    monitor: monitorText.trim() ? Number(monitorText.trim()) : undefined,
  };
  if (where.value === "here" && editor) {
    if (await canListen()) {
      options.follow = cursorLine(project, editor);
    } else {
      options.from = slide;
    }
  }
  await launch(options, project);
}

/** Every slide name of the project and its stops, for pickers. */
export function seekTargets(project: Project): { label: string; description: string; value: string }[] {
  const seen = new Set<string>();
  const items: { label: string; description: string; value: string }[] = [];
  for (const symbol of projectSymbols(project)) {
    if (symbol.name && !seen.has(symbol.name) && (symbol.kind === "segment" || symbol.kind === "section" || symbol.kind === "stop")) {
      seen.add(symbol.name);
      items.push({
        label: `${symbol.kind === "stop" ? "$(debug-pause)" : "$(preview)"} ${symbol.name}`,
        description: symbol.kind,
        value: symbol.name,
      });
    }
  }
  return items;
}

/** Asks where to move the preview: a slide, a stop or a time. */
export async function seekPick(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const quickPick = vscode.window.createQuickPick<{ label: string; description: string; value: string }>();
  quickPick.title = "Move the preview to";
  quickPick.placeholder = "A slide, a stop, or a time in seconds";
  quickPick.items = seekTargets(project);
  quickPick.onDidAccept(() => {
    const value = quickPick.selectedItems[0]?.value ?? quickPick.value.trim();
    quickPick.hide();
    if (value) {
      void seek(value, project);
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

/** Asks what to loop: a slide or a range of seconds. */
export async function loopPick(): Promise<void> {
  const project = requireProject();
  if (!project) {
    return;
  }
  const items = [
    ...(status.get(project.root)?.playhead?.loop ? [{ label: "$(circle-slash) Stop looping", description: "", value: "off" }] : []),
    ...seekTargets(project).filter((item) => item.description !== "stop"),
  ];
  const quickPick = vscode.window.createQuickPick<{ label: string; description: string; value: string }>();
  quickPick.title = "Loop in the preview";
  quickPick.placeholder = "A slide, or a range in seconds such as 1.2 3.4";
  quickPick.items = items;
  quickPick.onDidAccept(() => {
    const value = quickPick.selectedItems[0]?.value ?? quickPick.value.trim();
    quickPick.hide();
    const range = /^\s*([\d.]+)\s+([\d.]+)\s*$/.exec(value);
    if (range) {
      void loop({ start: Number(range[1]), end: Number(range[2]) }, project);
    } else if (value) {
      void loop(value === "off" ? "off" : value, project);
    }
  });
  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

/** The symbols of the document in the active editor, for motions. */
export function moveTo(direction: 1 | -1, kinds: ReadonlySet<string>): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const line = editor.selection.active.line + 1;
  const symbols = documentSymbols(editor.document).filter((symbol) => kinds.has(symbol.kind));
  const target =
    direction > 0 ? symbols.find((symbol) => symbol.line > line) : [...symbols].reverse().find((symbol) => symbol.line < line);
  if (target) {
    const position = new vscode.Position(target.line - 1, target.column);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
