#!/usr/bin/env node
// A stand-in for `gaanim` that speaks its JSON protocols, for the integration test.
// Every invocation and every `--listen` command is appended to $FAKE_GAANIM_LOG.

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const logFile = process.env.FAKE_GAANIM_LOG;
const note = (entry) => logFile && fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
note({ args, editor: process.env.GAANIM_EDITOR ?? null });

const emit = (object) => process.stdout.write(JSON.stringify(object) + "\n");

function timeline(target) {
  const root = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const fixture = path.join(__dirname, "..", "fixtures", "talk.inspect.json");
  return JSON.parse(fs.readFileSync(fixture, "utf8").replaceAll("{root}", root.replace(/\\/g, "/")));
}

const GENERAL = `Write animations in Python, preview them live, and export videos or slides.

Commands:
  init <video|slides> [DIR]       Create a project
  inspect <SCRIPT_OR_PROJECT> [--json]  List the timeline
  export <SCRIPT_OR_PROJECT>      Export

Options:
  --listen <stdio|HOST:PORT>      Let an editor drive the preview
  --message-format <FORMAT>       human or json
`;

const EXPORT = `Options:
  --from <SECONDS|NAME>
  --to <SECONDS|NAME>
  --frame <SECONDS|NAME>[,...]
  --message-format <FORMAT>
`;

if (args[0] === "--help") {
  process.stdout.write(GENERAL);
} else if (args[0] === "export" && args[1] === "--help") {
  process.stdout.write(EXPORT);
} else if (args[0] === "--version") {
  process.stdout.write("gaanim 0.13.0 (fake)\n");
} else if (args[0] === "inspect") {
  process.stdout.write("a print from the script\n");
  emit(timeline(args[1]));
} else if (args[0] === "check") {
  const data = timeline(args[1]);
  emit({ type: "diagnostic", level: "warning", message: "segment `Closing` has no speaker notes", file: data.script, line: 27, column: null });
  emit({ type: "check", result: "pass", errors: 0, warnings: 1, segments: 3, stops: 4, duration: 2.8 });
  process.exit(0);
} else if (args[0] === "export") {
  const output = args[args.indexOf("--output") + 1];
  for (const percent of [0, 50, 100]) {
    emit({ type: "progress", current: percent, percent, done: percent === 100 });
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, "fake export");
  emit({ type: "message", level: "success", label: "export", message: `wrote ${output}` });
} else {
  // The preview.
  const target = args[args.length - 1];
  const data = timeline(target);
  emit({ event: "ready", duration: data.duration, timeline: data });
  if (args.includes("--listen")) {
    let pending = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const command = JSON.parse(line);
        note({ command });
        if (command.cmd === "follow" || command.cmd === "seek") {
          emit({ event: "playhead", time: 1.3, segment: "Problem", stop: "question", playing: false, loop: null });
        } else if (command.cmd === "loop") {
          emit({ event: "playhead", time: 0.8, segment: "Problem", stop: null, playing: true, loop: [0.8, 1.8] });
        } else if (command.cmd === "unloop") {
          emit({ event: "playhead", time: 0.8, segment: "Problem", stop: null, playing: false, loop: null });
        } else if (command.cmd === "play") {
          emit({ event: "playhead", time: 0.4, segment: "Cover", stop: null, playing: true, loop: null });
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
  }
  setInterval(() => undefined, 1000);
}
