// Gaanim: Check Setup — what the extension finds and what it can use.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as cli from "./cli";
import { config } from "./config";
import { docsDir } from "./docs";
import { editorCommand } from "./editorLink";
import { scriptPath } from "./narration";
import { count, label, same } from "./core/workspace";
import { currentProject, projectForFile } from "./project";
import { environment } from "./python";
import * as workspace from "./workspace";

export async function doctor(): Promise<void> {
  const lines: string[] = ["# Gaanim setup", ""];
  const ok = (text: string) => lines.push(`- ✅ ${text}`);
  const info = (text: string) => lines.push(`- ℹ️ ${text}`);
  const warn = (text: string, advice?: string) => lines.push(`- ⚠️ ${text}${advice ? ` — ${advice}` : ""}`);
  const error = (text: string, advice?: string) => lines.push(`- ❌ ${text}${advice ? ` — ${advice}` : ""}`);

  lines.push("## Gaanim", "");
  cli.resetCaps();
  const program = cli.executable(true);
  if (!program) {
    error(`\`${config.path()}\` not found`, "install Gaanim or set `gaanim.path`");
  } else {
    const version = (await cli.output(program, ["--version"]))?.trim();
    ok(`${version || "gaanim"} (\`${program}\`)`);
    const caps = await cli.caps();
    const feature = (on: boolean, name: string, what: string) =>
      on ? ok(`\`${name}\`: ${what}`) : info(`\`${name}\` is not in this Gaanim (\`gaanim update\` brings it): ${what}`);
    feature(caps.listen, "--listen", "preview at the cursor without a restart, follow the cursor, the playhead in the code");
    feature(caps.json, "--message-format json", "problems on their exact line, export progress in percent");
    feature(caps.inspect, "inspect", "times in the code, the timeline view, stills at the cursor");
    feature(caps.names, "export by name", "stills and ranges of the slide at the cursor");
    feature(caps.project, "project", "workspaces: members, shared Python and assets, the environment of each file");
  }
  for (const tool of ["ffmpeg", "ffprobe"]) {
    if (cli.which(tool)) {
      ok(`${tool} found`);
    } else {
      warn(`${tool} not found`, "MP4, WebM, MOV, GIF and WebP exports and video clips need FFmpeg; hovers use ffprobe");
    }
  }
  if (cli.which("uv")) {
    ok("uv found");
  } else {
    warn("uv not found", "`gaanim init` uses uv to create the project's Python environment");
  }
  const python = vscode.extensions.getExtension("ms-python.python");
  if (python) {
    ok("Python extension installed: it completes the Gaanim API from the project's `.venv`");
  } else {
    warn("No Python extension", "install ms-python.python (with Pylance or basedpyright) for completion and type checks of the Gaanim API");
  }
  info(`*Open in the editor* in Gaanim runs: \`${editorCommand()}\``);

  const editor = vscode.window.activeTextEditor;
  const file = editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined;
  const found = await workspace.current(true);
  if (found) {
    lines.push("", "## Workspace", "");
    ok(`${found.name} · \`${found.root}\``);
    const active = workspace.activeMember(found.root);
    const invalid = found.members.filter((member) => member.error).length;
    if (found.members.length === 0) {
      warn("No members yet", "**New Video** or **New Presentation** in the Projects view adds one");
    } else {
      info(`${count(found.members.length)}${invalid > 0 ? `, ${invalid} invalid` : ""}:`);
    }
    for (const member of found.members) {
      const mark = member.error ? "❌" : active && same(active, member.root) ? "▶️" : "▫️";
      lines.push(
        `  - ${mark} **${label(member)}** \`${member.path}\`${member.error ? ` — ${member.error}` : ` · ${member.kind}`}${active && same(active, member.root) ? " · the shared files run as this member" : ""}`,
      );
    }
    const relative = (dir: string) => `\`${path.relative(found.root, dir) || "."}\``;
    info(`Shared Python: ${found.python.length > 0 ? found.python.map(relative).join(", ") : "none"}`);
    info(`Shared assets: ${found.assets.length > 0 ? found.assets.map(relative).join(", ") : "none"}`);
    if (!active && found.members.some((member) => !member.error)) {
      info("No active member yet: the shared files run as the member whose files you open, or the one you pick");
    }
  }

  lines.push("", "## Current project", "");
  const project = currentProject();
  if (!project) {
    info(found ? "The current file is one of the workspace's own, and no member runs it yet" : "No Gaanim project around the current file or workspace");
  } else {
    ok(`${project.name} · ${project.kind} · \`${project.root}\``);
    if (!fs.existsSync(project.entry)) {
      error(`Entry script missing: \`${project.entry}\``);
    }
    const env = await environment(project, file && projectForFile(file)?.root === project.root ? file : project.entry);
    const base = env.workspaceRoot ?? project.root;
    if (env.interpreter && fs.existsSync(env.interpreter)) {
      ok(`Python: \`${path.relative(base, env.interpreter)}\`${env.workspaceRoot ? " (the workspace's environment)" : ""}`);
    } else if (project.kind !== "script") {
      warn(
        env.workspaceRoot ? "No Python environment in the workspace yet" : "No `.venv` in the project",
        env.workspaceRoot ? "opening a member with gaanim prepares it" : "open the project with gaanim once, or run `gaanim init <kind> . --force`",
      );
    }
    if (env.paths.length > 0) {
      info("`sys.path` of its scripts:");
      for (const dir of env.paths) {
        lines.push(`  - \`${dir}\``);
      }
    }
    const docs = docsDir();
    if (docs) {
      ok(`Bundled docs: \`${docs}\``);
    } else {
      warn("No bundled docs found", "**Search Documentation** needs them");
    }
    const script = scriptPath(project);
    info(`Narration script: \`${path.relative(project.root, script.path)}\`${script.exists ? "" : " (not created yet)"}`);
  }
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: lines.join("\n") + "\n" });
  await vscode.commands.executeCommand("markdown.showPreview", document.uri).then(undefined, () =>
    vscode.window.showTextDocument(document),
  );
}
