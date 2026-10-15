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

async function main(): Promise<void> {
  const extension = path.resolve(__dirname, "..", "..", "..");
  // The space checks that paths with spaces reach gaanim whole.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gaanim vscode-"));
  const real = process.env.GAANIM_TEST_BIN;
  const source = real ? process.env.GAANIM_TEST_PROJECT : path.join(extension, "test", "fixtures", "talk");
  if (!source) {
    throw new Error("GAANIM_TEST_BIN needs GAANIM_TEST_PROJECT, a project made with gaanim init");
  }
  const project = path.join(work, "talk");
  fs.cpSync(source, project, { recursive: true, verbatimSymlinks: true });
  const bin = real ?? fakeGaanim(extension, work);
  fs.mkdirSync(path.join(project, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "gaanim.path": bin,
        "gaanim.export.open": "never",
        "gaanim.python.useProjectEnvironment": "never",
        "gaanim.check.onSave": false,
      },
      null,
      2,
    ),
  );
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? "stable",
    extensionDevelopmentPath: extension,
    extensionTestsPath: path.join(__dirname, "suite.js"),
    launchArgs: [project, "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", path.join(work, "user")],
    extensionTestsEnv: {
      GAANIM_TEST_REAL: real ? "1" : "",
      FAKE_GAANIM_LOG: path.join(work, "fake.log"),
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
