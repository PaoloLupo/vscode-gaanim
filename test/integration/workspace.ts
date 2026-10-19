// The workspace suite, run inside VS Code by run.ts over a copy of test/fixtures/channel.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { GaanimApi } from "../../src/extension";

const real = Boolean(process.env.GAANIM_TEST_REAL);

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeout = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function same(a: string | undefined, b: string): boolean {
  return a !== undefined && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

const steps: [string, () => Promise<void>][] = [];
const step = (name: string, run: () => Promise<void>) => steps.push([name, run]);

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const at = (...parts: string[]) => path.join(root, ...parts);
  const extension = vscode.extensions.getExtension<GaanimApi>("paololupo.gaanim")!;
  const api = await extension.activate();
  const intro = at("videos", "intro", "main.py");
  const style = at("common", "style.py");

  step("a workspace's manifest is no project, nor are its shared modules before a member runs them", async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(at("gaanim.toml")));
    assert.equal(api.projectFor(at("gaanim.toml")), undefined);
    assert.equal(api.projectFor(style), undefined);
    assert.equal(api.activeMember(root), undefined);
  });

  step("a script beside the shared folders is a project of its own", async () => {
    const sketch = api.projectFor(at("sketch.py"));
    assert.equal(sketch?.kind, "script");
    assert.ok(same(sketch?.root, root));
  });

  step("opening a member's file makes it the member the shared modules run as", async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(intro));
    await until("intro to be the active member", () => same(api.activeMember(root), at("videos", "intro")));
    const shared = api.projectFor(style);
    assert.equal(shared?.name, "intro");
    assert.ok(same(shared?.root, at("videos", "intro")));
    assert.ok(same(api.projectFor(intro)?.root, shared!.root), "the same project either way");
  });

  step("the Python environment is the workspace's, with its sys.path", async () => {
    const env = await api.environment(api.projectFor(intro)!, intro);
    assert.ok(same(env.workspaceRoot, root), env.workspaceRoot);
    assert.ok(env.interpreter && same(path.dirname(path.dirname(env.interpreter)), at(".venv")), env.interpreter);
    assert.ok(env.paths.some((dir) => same(dir, at("common"))), env.paths.join(", "));
  });

  step("asset names resolve in the shared asset folders, and complete marked shared", async () => {
    const scratch = at("videos", "intro", "scratch.py");
    fs.writeFileSync(scratch, 'from gaanim import Scene\nscene = Scene()\nscene.media.sfx("jingle.wav")\nscene.media.sfx("nothing.wav")\nscene.media.sfx("\n');
    const document = await vscode.workspace.openTextDocument(scratch);
    await vscode.window.showTextDocument(document);
    const warning = await until("the missing asset warning", () =>
      vscode.languages.getDiagnostics(document.uri).find((diagnostic) => diagnostic.message.includes("nothing.wav")),
    );
    assert.match(warning.message, /shared assets/);
    assert.ok(!vscode.languages.getDiagnostics(document.uri).some((diagnostic) => diagnostic.message.includes("jingle.wav")));
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      document.uri,
      new vscode.Position(4, 'scene.media.sfx("'.length),
    );
    const jingle = list.items.find((item) => (typeof item.label === "string" ? item.label : item.label.label) === "jingle.wav");
    assert.ok(jingle, "jingle.wav is offered");
    assert.match(typeof jingle.label === "string" ? "" : (jingle.label.description ?? ""), /^shared/);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    fs.rmSync(scratch);
  });

  step("the Projects view shows the workspace with its members by group, the invalid one marked", async () => {
    const top = await api.projects.getChildren();
    const node = top.find((item) => item.type === "workspace" && same(item.root, root));
    assert.ok(node, "the window's workspace heads the view");
    const groups = await api.projects.getChildren(node);
    assert.deepEqual(
      groups.map((item) => (item.type === "group" ? item.name : item.type)),
      ["Videos", "talks"],
    );
    const videos = await api.projects.getChildren(groups[0]);
    const items = videos.map((item) => api.projects.getTreeItem(item));
    assert.deepEqual(
      items.map((item) => [item.label, item.contextValue]),
      [
        ["intro", "gaanim.member"],
        ["outro", "gaanim.member.invalid"],
      ],
    );
    assert.match(String(items[0].description), /active/);
    assert.match((items[1].tooltip as vscode.MarkdownString).value, /unknown project kind/);
  });

  step("Check Setup shows the workspace, its members and the environment", async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(intro));
    await vscode.commands.executeCommand("gaanim.doctor");
    const report = await until("the setup report", () =>
      vscode.workspace.textDocuments.find((document) => document.isUntitled && document.getText().startsWith("# Gaanim setup")),
    );
    const text = report.getText();
    assert.match(text, /## Workspace/);
    assert.match(text, /videos\/outro.*unknown project kind/);
    assert.match(text, /Python: `\.venv[\\/]/);
    assert.match(text, /`sys\.path` of its scripts/);
    assert.doesNotMatch(text, /No `\.venv` in the project/);
  });

  step("one check of the workspace gives each member its problems", async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(intro));
    await vscode.commands.executeCommand("gaanim.checkWorkspace");
    const report = await until("the workspace's report", () => [...api.workspaceReports].find(([key]) => same(key, root))?.[1], 120_000);
    assert.equal(report.summary, "1 of 3 members passed · failed: videos/outro, talks/kickoff");
    const outro = vscode.languages.getDiagnostics(vscode.Uri.file(at("videos", "outro", "gaanim.toml")));
    assert.ok(outro.some((diagnostic) => /unknown project kind `nope`/.test(diagnostic.message) && !diagnostic.message.includes("\\\\?\\")), outro.map((d) => d.message).join(" | "));
    const kickoff = vscode.languages.getDiagnostics(vscode.Uri.file(at("talks", "kickoff", "main.py")));
    assert.ok(kickoff.some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error && /zero duration/.test(diagnostic.message)));
  });

  step("an export of the workspace writes each member under exports/{member}", async () => {
    await vscode.commands.executeCommand("gaanim.exportWorkspace", real ? "frame" : "mp4");
    const ext = real ? "-0.5.png" : ".mp4";
    await until("the intro export", () => fs.existsSync(at("exports", "videos", `intro${ext}`)), 180_000);
    if (!real) {
      assert.ok(fs.existsSync(at("exports", "talks", "kickoff.mp4")));
    }
  });

  step("a new presentation goes beside the other presentations and becomes the active member", async () => {
    await vscode.commands.executeCommand("gaanim.newMember", "slides", root, "retro");
    await until("talks/retro", () => fs.existsSync(at("talks", "retro", "gaanim.toml")), 60_000);
    await until("retro to be the active member", () => same(api.activeMember(root), at("talks", "retro")), 30_000);
    assert.equal(api.projectFor(style)?.name, "retro");
  });

  step("a project that members leaves out is not made the active member", async () => {
    await vscode.commands.executeCommand("gaanim.newMember", "video", root, "extras/teaser");
    await until("extras/teaser", () => fs.existsSync(at("extras", "teaser", "gaanim.toml")), 60_000);
    await until("its entry to open", () => same(vscode.window.activeTextEditor?.document.uri.fsPath, at("extras", "teaser", "main.py")), 30_000);
    assert.equal(api.projectFor(at("extras", "teaser", "main.py"))?.kind, "video");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.ok(same(api.activeMember(root), at("talks", "retro")), api.activeMember(root));
  });

  step("previewing a shared module previews the active member", async () => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(style));
    await vscode.commands.executeCommand("gaanim.previewHere");
    const key = await until("the member's preview", () => [...api.previews.keys()].find((root) => same(root, at("talks", "retro"))), 30_000);
    await until("the preview to be ready", () => api.previews.get(key)?.state === "ready", 120_000);
    await vscode.commands.executeCommand("gaanim.stop");
  });

  let failed = 0;
  for (const [name, runStep] of steps) {
    try {
      await runStep();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}\n    ${String(error).split("\n").join("\n    ")}`);
    }
  }
  console.log(`${steps.length - failed} passed, ${failed} failed (workspace, ${real ? "real gaanim" : "stand-in gaanim"})`);
  if (failed > 0) {
    throw new Error(`${failed} workspace integration steps failed`);
  }
}
