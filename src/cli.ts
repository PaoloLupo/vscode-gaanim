// Running the gaanim executable.

import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { config } from "./config";
import { Caps, NO_CAPS, parseCaps } from "./core/caps";
import { launch } from "./core/spawn";

export const log = vscode.window.createOutputChannel("Gaanim");

export interface RunOptions {
  cwd?: string;
  /** Tracks the process under this key, one at a time per key. */
  key?: string;
  /** Added to the inherited environment. */
  env?: Record<string, string>;
  /** Keep stdin open, for `send`. */
  stdin?: boolean;
  /** Lines that are JSON objects go here, not to `onLine`. */
  onJson?(object: Record<string, unknown>): void;
  onLine?(line: string): void;
  onExit?(code: number, lines: string[], objects: Record<string, unknown>[]): void;
}

export interface Job {
  process: ChildProcess;
  /** Closed on purpose by `stop`. */
  stopped: boolean;
  exited: boolean;
}

const jobs = new Map<string, Job>();

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A program found on PATH (with PATHEXT on Windows), or the path itself when it exists. */
export function which(program: string): string | undefined {
  if (program.includes("/") || program.includes("\\")) {
    return isFile(program) ? program : undefined;
  }
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const extension of ["", ...extensions]) {
      const candidate = path.join(dir, program + extension);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

let warned = false;

/** The configured executable resolved, or undefined after telling the person once. */
export function executable(quiet = false): string | undefined {
  const configured = config.path();
  const found = which(configured);
  if (!found && !quiet && !warned) {
    warned = true;
    void vscode.window
      .showErrorMessage(`\`${configured}\` was not found. Install Gaanim or set gaanim.path.`, "Open Settings", "Install Guide")
      .then((choice) => {
        warned = false;
        if (choice === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", "gaanim.path");
        } else if (choice === "Install Guide") {
          void vscode.env.openExternal(vscode.Uri.parse("https://paololupo.github.io/gaanim/empezar/instalacion/"));
        }
      });
  }
  return found;
}

/** Splits streamed output into lines; `\r` progress updates count as lines. */
function lineReader(onLine: (line: string) => void): { push(data: string): void; end(): void } {
  let pending = "";
  return {
    push(data) {
      pending += data;
      const parts = pending.split(/[\r\n]/);
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (part !== "") {
          onLine(part);
        }
      }
    },
    end() {
      if (pending !== "") {
        const rest = pending;
        pending = "";
        onLine(rest);
      }
    },
  };
}

/**
 * Runs `gaanim <args>`. Output goes to the log and, line by line, to
 * `onLine` (or `onJson` for JSON objects); `onExit` gets the exit code,
 * every line and every JSON object.
 */
export function run(args: string[], options: RunOptions = {}): Job | undefined {
  const program = executable();
  if (!program) {
    return undefined;
  }
  const lines: string[] = [];
  const objects: Record<string, unknown>[] = [];
  log.appendLine("");
  log.appendLine(`$ ${[program, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
  const onLine = (line: string) => {
    lines.push(line);
    log.appendLine(line);
    if (line.startsWith("{")) {
      try {
        const object = JSON.parse(line) as unknown;
        if (object && typeof object === "object" && !Array.isArray(object)) {
          objects.push(object as Record<string, unknown>);
          options.onJson?.(object as Record<string, unknown>);
          return;
        }
      } catch {
        // A print that only looks like JSON.
      }
    }
    options.onLine?.(line);
  };
  let child: ChildProcess;
  try {
    const start = launch(program, args);
    child = spawn(start.command, start.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: start.shell,
    });
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not start gaanim: ${String(error)}`);
    return undefined;
  }
  const job: Job = { process: child, stopped: false, exited: false };
  const out = lineReader(onLine);
  const err = lineReader(onLine);
  child.stdout?.setEncoding("utf8").on("data", (data: string) => out.push(data));
  child.stderr?.setEncoding("utf8").on("data", (data: string) => err.push(data));
  child.stdin?.on("error", () => undefined);
  let finished = false;
  const finish = (code: number) => {
    if (finished) {
      return;
    }
    finished = true;
    job.exited = true;
    out.end();
    err.end();
    if (options.key && jobs.get(options.key) === job) {
      jobs.delete(options.key);
    }
    log.appendLine(`[exit ${code}]`);
    options.onExit?.(code, lines, objects);
  };
  child.on("error", (error) => {
    log.appendLine(String(error));
    finish(-1);
  });
  child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  if (options.key) {
    const previous = jobs.get(options.key);
    if (previous) {
      stopJob(previous);
    }
    jobs.set(options.key, job);
  }
  return job;
}

/** Sends one JSON line to the stdin of the process under `key`. */
export function send(key: string, object: unknown): boolean {
  const job = jobs.get(key);
  if (!job || job.exited || !job.process.stdin || job.process.stdin.destroyed) {
    return false;
  }
  const line = JSON.stringify(object);
  try {
    job.process.stdin.write(`${line}\n`);
  } catch {
    return false;
  }
  log.appendLine(`> ${line}`);
  return true;
}

export function running(key: string): boolean {
  const job = jobs.get(key);
  return job !== undefined && !job.exited;
}

export function jobFor(key: string): Job | undefined {
  return jobs.get(key);
}

function stopJob(job: Job): void {
  job.stopped = true;
  if (!job.exited) {
    job.process.kill();
  }
}

export function stop(key: string): void {
  const job = jobs.get(key);
  if (job) {
    jobs.delete(key);
    stopJob(job);
  }
}

export function stopAll(): void {
  for (const key of [...jobs.keys()]) {
    stop(key);
  }
}

/** Runs a command and collects its output, for help texts and versions. */
export function output(program: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let text = "";
    let child: ChildProcess;
    try {
      const start = launch(program, args);
      child = spawn(start.command, start.args, {
        env: { ...process.env, NO_COLOR: "1" },
        windowsHide: true,
        shell: start.shell,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.setEncoding("utf8").on("data", (data: string) => (text += data));
    child.stderr?.setEncoding("utf8").on("data", (data: string) => (text += data));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
}

/** Runs `gaanim <args>` without logging it and collects stdout, stderr and the exit code; undefined when it cannot start. */
export function capture(args: string[], timeout = 15_000): Promise<{ code: number; stdout: string; stderr: string } | undefined> {
  const program = executable(true);
  if (!program) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    try {
      const start = launch(program, args);
      child = spawn(start.command, start.args, {
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: start.shell,
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout?.setEncoding("utf8").on("data", (data: string) => (stdout += data));
    child.stderr?.setEncoding("utf8").on("data", (data: string) => (stderr += data));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

const capsCache = new Map<string, Promise<Caps>>();

/** What the configured executable supports, read once from its help. */
export function caps(): Promise<Caps> {
  const program = executable(true);
  if (!program) {
    return Promise.resolve(NO_CAPS);
  }
  let cached = capsCache.get(program);
  if (!cached) {
    cached = Promise.all([output(program, ["--help"]), output(program, ["export", "--help"])]).then(([general, exportHelp]) =>
      parseCaps(general ?? "", exportHelp ?? ""),
    );
    capsCache.set(program, cached);
  }
  return cached;
}

/** Forget what was read, after the executable changes. */
export function resetCaps(): void {
  capsCache.clear();
  warned = false;
}
