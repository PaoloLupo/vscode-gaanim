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
  project [PATH] [--json]         Describe the project and workspace a file or folder belongs to

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

// Workspaces, as far as the test fixture `channel` needs: `members` with
// `dir/*` patterns and groups, `exclude`, and `[workspace.shared]`.

/** The quoted strings of a manifest's `key = [...]` (over several lines), with each `{ path, group }` entry's group. */
function listOf(text, key) {
  const match = new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\][^\\n]*$`, "m").exec(text);
  if (!match) {
    return undefined;
  }
  const entries = [];
  for (const part of match[1].replace(/#.*$/gm, "").matchAll(/\{([^}]*)\}|"([^"]*)"/g)) {
    if (part[1] !== undefined) {
      entries.push({ path: /path\s*=\s*"([^"]*)"/.exec(part[1])?.[1], group: /group\s*=\s*"([^"]*)"/.exec(part[1])?.[1] });
    } else {
      entries.push({ path: part[2] });
    }
  }
  return entries;
}

function isWorkspace(dir) {
  try {
    return /^\[workspace\]/m.test(fs.readFileSync(path.join(dir, "gaanim.toml"), "utf8"));
  } catch {
    return false;
  }
}

function workspaceAbove(target) {
  let dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
  for (;;) {
    if (isWorkspace(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function readManifest(dir) {
  const text = fs.readFileSync(path.join(dir, "gaanim.toml"), "utf8");
  const value = (key) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
  return { text, name: value("name") ?? path.basename(dir), kind: value("kind"), entry: value("entry") };
}

function members(root) {
  const { text } = readManifest(root);
  const workspaceText = text.slice(text.indexOf("[workspace]"));
  const excluded = (listOf(workspaceText, "exclude") ?? []).map((entry) => entry.path);
  const found = [];
  for (const entry of listOf(workspaceText, "members") ?? []) {
    const [parent, name] = entry.path.split("/");
    const dirs = name === "*" ? (fs.existsSync(path.join(root, parent)) ? fs.readdirSync(path.join(root, parent)).sort() : []) : [name];
    for (const dir of dirs) {
      const memberPath = `${parent}/${dir}`;
      const memberRoot = path.join(root, parent, dir);
      if (excluded.includes(memberPath) || !fs.existsSync(path.join(memberRoot, "gaanim.toml"))) {
        continue;
      }
      const manifest = readManifest(memberRoot);
      const valid = manifest.kind === "video" || manifest.kind === "slides";
      found.push({
        path: memberPath,
        name: manifest.name,
        group: entry.group ?? parent,
        root: memberRoot,
        kind: valid ? manifest.kind : null,
        entry: valid ? path.join(memberRoot, manifest.entry ?? "main.py") : null,
        error: valid ? null : `invalid project manifest \\\\?\\${path.join(memberRoot, "gaanim.toml")}: unknown project kind \`${manifest.kind}\``,
      });
    }
  }
  return found;
}

function shared(root, key, fallback) {
  const { text } = readManifest(root);
  const section = text.includes("[workspace.shared]") ? text.slice(text.indexOf("[workspace.shared]")) : "";
  return (listOf(section, key)?.map((entry) => entry.path) ?? [fallback])
    .map((name) => path.join(root, name))
    .filter((dir) => fs.existsSync(dir));
}

function describe(target) {
  const root = workspaceAbove(target);
  let dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
  let projectRoot;
  for (let up = dir; ; up = path.dirname(up)) {
    if (fs.existsSync(path.join(up, "gaanim.toml")) && readManifest(up).kind) {
      projectRoot = up;
      break;
    }
    if (up === root || path.dirname(up) === up) {
      break;
    }
  }
  const all = root ? members(root) : [];
  // A project inside the workspace that `members` leaves out stands alone.
  const outside = projectRoot && root && projectRoot !== root && !all.some((member) => member.root === projectRoot);
  const own = projectRoot ? readManifest(projectRoot) : undefined;
  const venv = root ?? projectRoot;
  const list = outside ? [] : all;
  const interpreter = venv && path.join(venv, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return {
    path: target,
    project: own
      ? {
          name: own.name,
          display_name: root ? `${readManifest(root).name} › ${own.name}` : own.name,
          kind: own.kind,
          root: projectRoot,
          manifest: path.join(projectRoot, "gaanim.toml"),
          entry: path.join(projectRoot, own.entry ?? "main.py"),
          assets_dir: path.join(projectRoot, "assets"),
          output_dir: path.join(projectRoot, "exports"),
          language: null,
        }
      : null,
    workspace: root && !outside
      ? {
          name: readManifest(root).name,
          root,
          manifest: path.join(root, "gaanim.toml"),
          cover: null,
          python: shared(root, "python", "src"),
          assets: shared(root, "assets", "assets"),
          members: list,
        }
      : null,
    python: {
      paths: [...new Set([dir, ...(projectRoot ? [projectRoot] : []), ...(root && !outside ? [...shared(root, "python", "src"), root] : [])])],
      venv: interpreter && fs.existsSync(interpreter) ? path.dirname(path.dirname(interpreter)) : null,
      interpreter: interpreter && fs.existsSync(interpreter) ? interpreter : null,
    },
  };
}

const target = args[1] && !args[1].startsWith("-") ? path.resolve(args[1]) : undefined;

if (args[0] === "--help" && process.env.FAKE_GAANIM_NO_PROJECT) {
  // An older gaanim, without `project` and so without workspaces.
  process.stdout.write(GENERAL.replace(/^ {2}project .*\n/m, ""));
} else if (args[0] === "project") {
  emit(describe(target ?? process.cwd()));
} else if (args[0] === "check" && target && isWorkspace(target)) {
  // The captured output of the real `gaanim check` of the fixture.
  const fixture = path.join(__dirname, "..", "fixtures", "channel.check.jsonl");
  process.stdout.write(fs.readFileSync(fixture, "utf8").replaceAll("{root}", target.replace(/\\/g, "/")));
  process.exit(1);
} else if (args[0] === "export" && target && isWorkspace(target)) {
  const output = args[args.indexOf("--output") + 1];
  const list = members(target);
  let passed = 0;
  for (const member of list) {
    if (member.error) {
      emit({ type: "message", level: "error", label: "export", message: `${member.path}: ${member.error}` });
      continue;
    }
    const file = output.replace("{member}", member.path);
    emit({ type: "message", level: "info", label: "export", message: `${member.path} · ${file}` });
    emit({ type: "progress", current: 1, percent: 100, done: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fake export");
    emit({ type: "message", level: "success", label: "export", message: `wrote ${file}` });
    passed++;
  }
  emit({ type: "workspace", name: readManifest(target).name, members: list.length, passed, failed: list.length - passed });
  process.exit(passed === list.length ? 0 : 1);
} else if (args[0] === "init" && (args[1] === "video" || args[1] === "slides")) {
  const dir = path.resolve(args[2]);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "gaanim.toml"), `name = "${path.basename(dir)}"\nkind = "${args[1]}"\nentry = "main.py"\n`);
  fs.writeFileSync(path.join(dir, "main.py"), "from gaanim import Scene\n\nscene = Scene()\nscene.wait(1)\nscene.render()\n");
  const root = workspaceAbove(path.dirname(dir));
  const member = Boolean(root && members(root).some((item) => item.root === dir));
  const outside = root && !member ? path.relative(root, dir) : undefined;
  const add = outside && `Add it in gaanim.toml: members = [..., "${outside.split(path.sep).join("/")}"]`;
  if (args.includes("--message-format")) {
    // As Gaanim 0.15 with `init --message-format json` writes it.
    if (outside) {
      emit({ type: "message", level: "warning", label: "init", message: `${outside} is inside workspace ${readManifest(root).name}, whose members do not include it` });
      emit({ type: "hint", message: add });
    }
    emit({ type: "message", level: "success", label: "init", message: `Created ${args[1]} project: ${dir}` });
    emit({ type: "init", kind: args[1], root: dir, entry: path.join(dir, "main.py"), workspace: root ?? null, member });
  } else {
    // As older versions write it, with Windows' verbatim prefix.
    if (outside) {
      console.log(`  ! init      ${outside} is inside workspace ${readManifest(root).name}, whose members do not include it`);
      console.log(`              ${add}`);
    }
    console.log(`  ✓ init      Created ${args[1]} project: \\\\?\\${dir}`);
  }
} else if (args[0] === "init" && args[1] === "--help") {
  process.stdout.write(`Usage: gaanim init <KIND> [DIRECTORY] [--force]${process.env.FAKE_GAANIM_NO_PROJECT ? "" : " [--message-format <FORMAT>]"}\n`);
} else if (args[0] === "--help") {
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
