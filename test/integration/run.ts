// Runs the integration suite in a real VS Code: `npm run test:integration`.
//
// By default it drives a stand-in `gaanim` (fake-gaanim.js) over a copy of
// test/fixtures/talk. With GAANIM_TEST_BIN set to a real gaanim and
// GAANIM_TEST_PROJECT to a project made with `gaanim init`, it drives the real
// one; its preview needs a display and a GPU (Xvfb and Mesa's lavapipe work).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

/**
 * The stand-in gaanim. Windows does not run a script from its shebang, so
 * there it is wrapped in a `.cmd`, which also exercises a gaanim.path that is
 * a batch file.
 */
function fakeGaanim(extension: string, work: string): string {
  const script = path.join(extension, "test", "integration", "fake-gaanim.js");
  if (process.platform !== "win32") {
    return script;
  }
  const wrapper = path.join(work, "fake-gaanim.cmd");
  fs.writeFileSync(wrapper, `@"${process.execPath}" "${script}" %*\r\n`);
  return wrapper;
}

/** Copies a project or workspace into `work` with settings that keep the suite from waiting on prompts. */
function prepare(source: string, folder: string, bin: string, extra: Record<string, unknown> = {}): void {
  fs.cpSync(source, folder, { recursive: true, verbatimSymlinks: true });
  fs.mkdirSync(path.join(folder, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "gaanim.path": bin,
        "gaanim.export.open": "never",
        "gaanim.python.useProjectEnvironment": "never",
        "gaanim.check.onSave": false,
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const extension = path.resolve(__dirname, "..", "..", "..");
  // The space checks that paths with spaces reach gaanim whole.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gaanim vscode-"));
  const real = process.env.GAANIM_TEST_BIN;
  const source = real ? process.env.GAANIM_TEST_PROJECT : path.join(extension, "test", "fixtures", "talk");
  // With the real gaanim, a copy of test/fixtures/channel with a .venv (the workspace suite runs only with it).
  const workspaceSource = real ? process.env.GAANIM_TEST_WORKSPACE : path.join(extension, "test", "fixtures", "channel");
  if (!source) {
    throw new Error("GAANIM_TEST_BIN needs GAANIM_TEST_PROJECT, a project made with gaanim init");
  }
  const bin = real ?? fakeGaanim(extension, work);
  const suites: { name: string; folder: string; tests: string }[] = [];
  if (!process.env.GAANIM_TEST_ONLY || process.env.GAANIM_TEST_ONLY === "project") {
    const project = path.join(work, "talk");
    prepare(source, project, bin);
    suites.push({ name: "project", folder: project, tests: "suite.js" });
  }
  if (workspaceSource && (!process.env.GAANIM_TEST_ONLY || process.env.GAANIM_TEST_ONLY === "workspace")) {
    const channel = path.join(work, "channel");
    // A still every member can export, without asking for a frame.
    prepare(workspaceSource, channel, bin, { "gaanim.export.presets": { frame: { ext: "png", args: ["--frame", "0.5"], desc: "A still at 0.5 s" } } });
    if (!real) {
      // The stand-in's workspace environment: an interpreter that only has to exist.
      const python = path.join(channel, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      fs.mkdirSync(path.dirname(python), { recursive: true });
      fs.writeFileSync(python, "");
    }
    suites.push({ name: "workspace", folder: channel, tests: "workspace.js" });
  }
  for (const suite of suites) {
    console.log(`\n${suite.name} suite`);
    await runTests({
      version: process.env.VSCODE_TEST_VERSION ?? "stable",
      extensionDevelopmentPath: extension,
      extensionTestsPath: path.join(__dirname, suite.tests),
      launchArgs: [suite.folder, "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", path.join(work, `user-${suite.name}`)],
      extensionTestsEnv: {
        GAANIM_TEST_REAL: real ? "1" : "",
        FAKE_GAANIM_LOG: path.join(work, `fake-${suite.name}.log`),
      },
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
