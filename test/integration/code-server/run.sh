#!/bin/bash
# Runs test/integration/suite.ts inside code-server, for machines where
# @vscode/test-electron cannot download VS Code. Needs code-server and
# playwright-core installed somewhere (CODE_SERVER_DIR) and xvfb-run.
#
#   CODE_SERVER_DIR=~/cs test/integration/code-server/run.sh <project> <gaanim> [real]
#
# <project> is a copy source (test/fixtures/talk with the stand-in
# fake-gaanim.js, or a project from `gaanim init` with a real gaanim; pass
# `real` as the third argument then). A real preview needs a GPU or Mesa's
# lavapipe: VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$(cd "$HERE/../../.." && pwd)
CSD=${CODE_SERVER_DIR:?set CODE_SERVER_DIR to a folder with code-server and playwright-core installed}
CS=$CSD/node_modules/.bin/code-server
PORT=${PORT:-18080}
W=$(mktemp -d)
mkdir -p "$W/user/User" "$W/exts" "$W/runner"
echo '{"security.workspace.trust.enabled": false, "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off"}' > "$W/user/User/settings.json"
cp -r "$1" "$W/talk"
mkdir -p "$W/talk/.vscode"
cat > "$W/talk/.vscode/settings.json" <<JSON
{ "gaanim.path": "$2", "gaanim.export.open": "never", "gaanim.python.useProjectEnvironment": "never", "gaanim.check.onSave": false }
JSON
(cd "$EXT" && npm run package >/dev/null && npx tsc -p tsconfig.test.json)
cp "$HERE/package.json" "$HERE/main.js" "$W/runner/"
echo "# runner" > "$W/runner/README.md"; cp "$EXT/LICENSE" "$W/runner/"
(cd "$W/runner" && "$EXT/node_modules/.bin/vsce" package --allow-missing-repository --skip-license -o "$W/runner.vsix" >/dev/null)
"$CS" --extensions-dir "$W/exts" --user-data-dir "$W/user" --install-extension "$EXT"/gaanim-*.vsix >/dev/null 2>&1
"$CS" --extensions-dir "$W/exts" --user-data-dir "$W/user" --install-extension "$W/runner.vsix" >/dev/null 2>&1
export GAANIM_TEST_SUITE=$EXT/out/test/integration/suite.js GAANIM_TEST_RESULTS=$W/results.txt GAANIM_TEST_REAL="${3:+1}" FAKE_GAANIM_LOG=$W/fake.log
xvfb-run -a -s "-screen 0 1280x800x24" "$CS" --auth none --bind-addr "127.0.0.1:$PORT" --extensions-dir "$W/exts" \
  --user-data-dir "$W/user" --disable-telemetry --disable-update-check --disable-workspace-trust > "$W/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && break; sleep 1; done
(cd "$CSD" && node -e '
const { chromium } = require("playwright-core");
const fs = require("fs");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${process.argv[1]}/?folder=` + encodeURIComponent(process.argv[2]));
  const start = Date.now();
  while (!fs.existsSync(process.argv[3]) && Date.now() - start < 600000) await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: process.argv[4] });
  await browser.close();
})();
' "$PORT" "$W/talk" "$W/results.txt" "$W/shot.png")
kill "$SERVER" 2>/dev/null
cat "$W/results.txt" 2>/dev/null || { echo "no results"; tail -40 "$W/server.log"; }
echo "work folder: $W (Gaanim log: user/logs/*/exthost1/output_logging_*/*Gaanim.log)"
grep -q "RESULT ok" "$W/results.txt" 2>/dev/null
