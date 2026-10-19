// Workspaces: several projects in one repository that share Python, assets and one `.venv`.
//
// `gaanim project <PATH> --json` says, without running Python, what a file
// or folder belongs to: its project, its workspace with every member, the
// folders its scripts find on `sys.path` and the interpreter. The extension
// keeps what it says; this module reads it and works out what follows.

import * as path from "node:path";
import { fromJson, LocateContext, Report } from "./check";

export interface Member {
  /** Folder relative to the workspace, with `/`. */
  path: string;
  name: string;
  /** Its `members` entry's group, else the folder that holds it. */
  group: string;
  root: string;
  /** Undefined when its manifest is invalid. */
  kind?: "video" | "slides";
  entry?: string;
  /** Why its manifest cannot be read. */
  error?: string;
}

export interface Workspace {
  name: string;
  root: string;
  manifest: string;
  cover?: string;
  /** Shared Python folders, absolute. */
  python: string[];
  /** Shared asset folders, absolute. */
  assets: string[];
  members: Member[];
}

export interface DescribedProject {
  name: string;
  /** `channel › intro` in a workspace. */
  displayName: string;
  kind: string;
  root: string;
  manifest: string;
  entry: string;
  assetsDir: string;
  outputDir: string;
  language?: string;
}

/** What `gaanim project --json` says of a path. */
export interface Description {
  path: string;
  project?: DescribedProject;
  workspace?: Workspace;
  python: {
    /** The folders on `sys.path`, first to last. */
    paths: string[];
    venv?: string;
    interpreter?: string;
  };
}

/** Text without Windows' `\\?\` prefix, which Gaanim's messages may carry. */
export function stripVerbatim(text: string): string {
  return text.replace(/\\\\\?\\UNC\\/g, "\\\\").replace(/\\\\\?\\/g, "");
}

/** A path as the extension writes it: normalized, without `\\?\`. */
export function plain(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return path.normalize(stripVerbatim(value));
}

function comparable(value: string): string {
  let normalized = path.normalize(value);
  if (normalized.length > 1) {
    normalized = normalized.replace(/[\\/]+$/, "");
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Whether two paths name the same file. */
export function same(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && comparable(a) === comparable(b);
}

/** Whether `file` is `folder` or lies inside it. */
export function within(file: string, folder: string): boolean {
  const f = comparable(file);
  const d = comparable(folder);
  return f === d || f.startsWith(d + path.sep);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

type ToPath = (value: unknown) => string | undefined;

function paths(value: unknown, p: ToPath): string[] {
  return Array.isArray(value) ? value.map((item) => p(item)).filter((item): item is string => item !== undefined) : [];
}

function decodeMember(raw: Record<string, unknown>, p: ToPath): Member {
  const kind = raw.kind === "video" || raw.kind === "slides" ? raw.kind : undefined;
  const memberPath = text(raw.path) ?? "";
  return {
    path: memberPath,
    name: text(raw.name) ?? memberPath,
    group: text(raw.group) ?? "",
    root: p(raw.root) ?? "",
    kind,
    entry: p(raw.entry),
    error: typeof raw.error === "string" ? stripVerbatim(raw.error) : undefined,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Reads the JSON of `gaanim project --json`, with every path written the
 * extension's way: normalized, without `\\?\`, then through `toPath`
 * (VS Code writes a drive letter in lower case).
 */
export function decode(object: unknown, toPath: (file: string) => string = (file) => file): Description {
  const p: ToPath = (value) => {
    const file = plain(value);
    return file === undefined ? undefined : toPath(file);
  };
  const raw = record(object) ?? {};
  const python = record(raw.python) ?? {};
  const description: Description = {
    path: p(raw.path) ?? "",
    python: { paths: paths(python.paths, p), venv: p(python.venv), interpreter: p(python.interpreter) },
  };
  const project = record(raw.project);
  if (project) {
    const name = text(project.name) ?? "";
    description.project = {
      name,
      displayName: text(project.display_name) ?? name,
      kind: text(project.kind) ?? "video",
      root: p(project.root) ?? "",
      manifest: p(project.manifest) ?? "",
      entry: p(project.entry) ?? "",
      assetsDir: p(project.assets_dir) ?? "",
      outputDir: p(project.output_dir) ?? "",
      language: text(project.language),
    };
  }
  const workspace = record(raw.workspace);
  if (workspace) {
    const root = p(workspace.root) ?? "";
    description.workspace = {
      name: text(workspace.name) ?? path.basename(root),
      root,
      manifest: p(workspace.manifest) ?? path.join(root, "gaanim.toml"),
      cover: p(workspace.cover),
      python: paths(workspace.python, p),
      assets: paths(workspace.assets, p),
      members: Array.isArray(workspace.members)
        ? workspace.members.map(record).filter((item): item is Record<string, unknown> => item !== undefined).map((member) => decodeMember(member, p))
        : [],
    };
  }
  return description;
}

/** Why `gaanim project` gave no description: the text of its `✗` line. */
export function failure(output: string): string {
  const clean = stripVerbatim(output).trim();
  const line = /✗\s+\S+\s+(.*)/.exec(clean);
  return line ? line[1].trim() : clean.split(/\r?\n/).pop() ?? "";
}

export interface ManifestInfo {
  /** It names a project: `kind` or `entry` at the top. */
  project: boolean;
  /** It has a `[workspace]` table. */
  workspace: boolean;
  name?: string;
  /** `[workspace.shared]` python, as written. */
  python?: string[];
  /** `[workspace.shared]` assets, as written. */
  assets?: string[];
}

function strings(value: string): string[] {
  return [...value.matchAll(/(["'])(.*?)\1/g)].map((match) => match[2]);
}

/**
 * What a gaanim.toml declares, read without Gaanim: whether it names a
 * project, whether it is a workspace and the shared folders it lists (used
 * only while `gaanim project` has not answered, or cannot).
 */
export function manifestInfo(source: string): ManifestInfo {
  const info: ManifestInfo = { project: false, workspace: false };
  let section: string | undefined;
  let pending: { key: "python" | "assets"; value: string } | undefined;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s#[^"']*$/, "");
    if (pending) {
      // An array that goes on over several lines.
      pending.value += ` ${line}`;
      if (line.includes("]")) {
        info[pending.key] = strings(pending.value);
        pending = undefined;
      }
      continue;
    }
    const header = /^\[\s*([\w.-]+)\s*\]/.exec(line);
    if (header) {
      section = header[1];
      if (section === "workspace" || section.startsWith("workspace.")) {
        info.workspace = true;
      }
    } else if (section === undefined) {
      if (/^(kind|entry)\s*=/.test(line)) {
        info.project = true;
      }
      info.name ??= /^name\s*=\s*["'](.*?)["']/.exec(line)?.[1];
    } else if (section === "workspace.shared") {
      const entry = /^(python|assets)\s*=\s*(.*)$/.exec(line);
      if (entry) {
        const key = entry[1] as "python" | "assets";
        if (entry[2].includes("[") && !entry[2].includes("]")) {
          pending = { key, value: entry[2] };
        } else {
          info[key] = strings(entry[2]);
        }
      }
    }
  }
  return info;
}

/** The member whose folder holds `file`. */
export function memberAt(workspace: Workspace, file: string): Member | undefined {
  return workspace.members.find((member) => member.root && within(file, member.root));
}

/** The member at a path relative to the workspace, or at a root. */
export function member(workspace: Workspace, where: string): Member | undefined {
  return workspace.members.find((item) => item.path === where || same(item.root, where));
}

/** Whether `file` lies in one of the shared Python folders: a module the members import. */
export function isShared(folders: string[], file: string): boolean {
  return folders.some((folder) => within(file, folder));
}

/** `1 member`, `3 members`. */
export function count(n: number): string {
  return n === 1 ? "1 member" : `${n} members`;
}

/** How a member is named in lists: `group › name`. */
export function label(item: Member): string {
  return item.group ? `${item.group} › ${item.name}` : item.name;
}

/** The members by group, in the order the manifest lists them; members without a group first. */
export function groups(workspace: Workspace): { name: string; members: Member[] }[] {
  const out: { name: string; members: Member[] }[] = [];
  for (const item of workspace.members) {
    let group = out.find((entry) => entry.name === item.group);
    if (!group) {
      group = { name: item.group, members: [] };
      out.push(group);
    }
    group.members.push(item);
  }
  return out.sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : 0));
}

export interface CheckPart {
  member: string;
  /** The `check` line that names the member. */
  verdict: Record<string, unknown>;
  /** The lines about it, before its verdict. */
  objects: Record<string, unknown>[];
}

/**
 * Splits the JSON lines of `gaanim check <workspace>` by member: each
 * member's diagnostics come before the `check` verdict that names it. Also
 * gives what came after the last verdict, and the closing summary.
 */
export function splitCheck(objects: Record<string, unknown>[]): {
  parts: CheckPart[];
  rest: Record<string, unknown>[];
  summary?: { members: number; passed: number; failed: number };
} {
  const parts: CheckPart[] = [];
  let pending: Record<string, unknown>[] = [];
  let summary: { members: number; passed: number; failed: number } | undefined;
  for (const object of objects) {
    if (object.type === "check" && typeof object.member === "string") {
      parts.push({ member: object.member, verdict: object, objects: pending });
      pending = [];
    } else if (object.type === "workspace") {
      summary = { members: Number(object.members) || 0, passed: Number(object.passed) || 0, failed: Number(object.failed) || 0 };
    } else {
      pending.push(object);
    }
  }
  return { parts, rest: pending, summary };
}

/** Whether a member's verdict is a failure. */
export function failed(verdict: Record<string, unknown>): boolean {
  return verdict.result === "error" || verdict.result === "fail";
}

export interface MemberReport {
  member: Member;
  report: Report;
}

/**
 * Turns the JSON lines of `gaanim check <workspace>` into a report per
 * member, in the order they ran. A member that could not load has an error
 * on its manifest even when no line said where.
 */
export function memberReports(
  workspace: Workspace,
  objects: Record<string, unknown>[],
  context: (item: Member) => LocateContext,
): MemberReport[] {
  return splitCheck(objects).parts.map((part) => {
    const item = member(workspace, part.member) ?? {
      path: part.member,
      name: part.member,
      group: "",
      root: path.join(workspace.root, ...part.member.split("/")),
    };
    const clean = part.objects.map((object) =>
      typeof object.message === "string" ? { ...object, message: stripVerbatim(object.message) } : object,
    );
    const where = context(item);
    const report = fromJson([...clean, part.verdict], [], where);
    if (failed(part.verdict)) {
      report.status = "error";
      if (!report.problems.some((problem) => problem.severity === "error")) {
        const text = item.error ?? "could not load the project";
        report.problems.push({ file: path.join(item.root, "gaanim.toml"), line: 1, column: 1, severity: "error", text });
        report.summary = text;
      }
    }
    return { member: item, report };
  });
}

/** `2 of 3 members passed · 1 with warnings · failed: videos/outro`. */
export function checkSummary(results: { member: string; status: "pass" | "warning" | "error" }[]): string {
  const failures = results.filter((result) => result.status === "error").map((result) => result.member);
  const warned = results.filter((result) => result.status === "warning").length;
  let summary = `${results.length - failures.length} of ${count(results.length)} passed`;
  if (warned > 0) {
    summary += ` · ${warned} with warnings`;
  }
  if (failures.length > 0) {
    summary += ` · failed: ${failures.join(", ")}`;
  }
  return summary;
}

/**
 * The `--output` of a workspace export: `pattern` under the workspace's root
 * (with `{member}` added when it lacks it), the preset's suffix and extension.
 */
export function workspaceOutput(root: string, pattern: string, suffix: string, ext: string): string {
  let output = pattern.replace(/[\\/]+$/, "") || "exports";
  if (!output.includes("{member}")) {
    output += "/{member}";
  }
  output += `${suffix}.${ext}`;
  return path.normalize(path.isAbsolute(output) || /^[A-Za-z]:[\\/]/.test(output) ? output : path.join(root, output));
}

/** The member a workspace export starts on, from its `videos/intro · exports/…` message. */
export function exportStart(message: string): string | undefined {
  return /^(\S.*?) · /.exec(message)?.[1];
}

/**
 * The folder, relative to the workspace, a new member named `name` goes in:
 * a name with a `/` is a path from the workspace's root; a bare name goes
 * beside the active member when it is of that kind, else beside the first
 * member of that kind, else beside the first member, else at the root.
 * Without a name, that folder with a trailing `/` (or "").
 */
export function memberPath(workspace: Workspace, kind: string, name?: string, active?: string): string {
  if (name && /[\\/]/.test(name)) {
    return name.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }
  const parent = (item: Member) => (item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "");
  const activeMember = active ? workspace.members.find((item) => same(item.root, active) && item.kind === kind) : undefined;
  const beside = activeMember ?? workspace.members.find((item) => item.kind === kind) ?? workspace.members[0];
  const folder = beside ? parent(beside) : "";
  const prefix = folder ? `${folder}/` : "";
  return name ? prefix + name : prefix;
}

/** What `gaanim init` warned about, such as a folder `members` leaves out, each warning with the lines that follow it. */
export function initWarnings(lines: string[]): string[] {
  const found: string[] = [];
  let open = false;
  for (const line of lines) {
    const warning = /^\s\s!\s+\S+\s+(.*)$/.exec(line);
    if (warning) {
      found.push(stripVerbatim(warning[1].trim()));
      open = true;
    } else if (open && /^\s{4,}\S/.test(line) && !/^\s\s\S/.test(line)) {
      found[found.length - 1] += ` ${stripVerbatim(line.trim())}`;
    } else {
      open = false;
    }
  }
  return found;
}

export interface SearchPathContext {
  /** The file being edited. */
  file: string;
  /** The VS Code folder that holds it: Pylance searches its root on its own. */
  folder?: string;
  /** `python.analysis.autoSearchPaths`: Pylance adds the folder's `src` on its own. */
  autoSearchPaths: boolean;
  /** `python.analysis.extraPaths` as it is, relative to the folder or absolute. */
  extraPaths: string[];
}

/** An `extraPaths` entry as an absolute path. */
export function resolveExtraPath(entry: string, folder?: string): string {
  const expanded = folder ? entry.replace(/\$\{workspaceFolder\}/g, folder) : entry;
  return folder && !path.isAbsolute(expanded) && !/^[A-Za-z]:[\\/]/.test(expanded) ? path.join(folder, expanded) : expanded;
}

/**
 * The folders of `sys.path` that Pylance does not find on its own: not the
 * VS Code folder (nor its `src` while autoSearchPaths is on), not the file's
 * own folder (imports beside a file resolve by themselves), not one
 * `extraPaths` already has.
 */
export function missingSearchPaths(paths: string[], context: SearchPathContext): string[] {
  const known = context.extraPaths.map((entry) => resolveExtraPath(entry, context.folder));
  const skip = [path.dirname(context.file), ...known];
  if (context.folder) {
    skip.push(context.folder);
    if (context.autoSearchPaths) {
      skip.push(path.join(context.folder, "src"));
    }
  }
  const missing: string[] = [];
  for (const folder of paths) {
    if (!skip.some((other) => same(folder, other)) && !missing.some((other) => same(folder, other))) {
      missing.push(folder);
    }
  }
  return missing;
}

/** How a folder is written in `extraPaths`: relative to the VS Code folder with `/` when inside it, else absolute. */
export function extraPathEntry(folder: string, root?: string): string {
  if (root && within(folder, root)) {
    return path.relative(root, folder).split(path.sep).join("/") || ".";
  }
  return folder;
}
