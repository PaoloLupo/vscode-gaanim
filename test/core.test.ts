// Unit tests of the parts that do not need VS Code: `npm test`.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assetReferences } from "../src/core/assets";
import { parseCaps } from "../src/core/caps";
import { entries as checkEntries, fromJson, fromText, LocateContext, traceback, warningRefs } from "../src/core/check";
import { clock, parseDuration, secondsArg, span, talkClock } from "../src/core/clock";
import { numberAt, step } from "../src/core/nudge";
import { findSection, mark, pace, parseScript, sectionAt, sectionInsert, spoken } from "../src/core/script";
import { evalNumber, parseSymbols, receiver, slideAt, STRUCTURE } from "../src/core/symbols";
import { entries, findTimeline, hoverLines, lineLabels, location, pathKey, playsAt, pointAt, segmentAt, Timeline } from "../src/core/timeline";
import { findPhrase, normalizeWord, TakeTiming, textWords, voiceoverBlocks } from "../src/core/takes";
import { glyph, mathItems, scan } from "../src/core/typst";
import { cmdQuote, launch } from "../src/core/spawn";
import { readTopLevel } from "../src/core/toml";

const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures");
const ROOT = path.join(FIXTURES, "talk");
const MAIN = path.join(ROOT, "main.py");
const SCRIPT = path.join(ROOT, "assets", "narration", "script.md");

function timeline(): Timeline {
  const text = fs.readFileSync(path.join(FIXTURES, "talk.inspect.json"), "utf8").replaceAll("{root}", ROOT.replace(/\\/g, "/"));
  return JSON.parse(text) as Timeline;
}

describe("symbols", () => {
  const symbols = parseSymbols(fs.readFileSync(MAIN, "utf8"), MAIN);

  it("finds segments, stops, markers and voiceovers in order", () => {
    assert.deepEqual(
      symbols.filter((s) => STRUCTURE.has(s.kind)).map((s) => `${s.kind}:${s.name ?? ""}:${s.line}`),
      [
        "segment:Cover:10",
        "stop:title:14",
        "segment:Problem:17",
        "stop:question:23",
        "marker:answer:24",
        "stop::25",
        "segment:Closing:27",
        "voiceover:outro:28",
        "stop:thanks:30",
      ],
    );
  });

  it("skips calls inside comments", () => {
    assert.ok(!symbols.some((s) => s.name === "Commented out"));
  });

  it("reads targets as arithmetic, on one line or several", () => {
    const targets = Object.fromEntries(
      symbols.filter((s) => s.kind === "segment" || s.kind === "talk").map((s) => [s.name ?? s.kind, s.target]),
    );
    assert.deepEqual(targets, { Cover: 30, Problem: 60, Closing: 90, talk: 240 });
  });

  it("reads Section keys and titles", () => {
    const found = parseSymbols('steps = [Section("4-1", [paso(a), paso(b)], title="Energy")]\nSectionStep(name=x)', "x.py");
    assert.equal(found.length, 1);
    assert.deepEqual([found[0].kind, found[0].name, found[0].title], ["section", "4-1", "Energy"]);
  });

  it("accepts project patterns", () => {
    const found = parseSymbols('"""Doc."""\nNAME = "Cover"\n', "slide.py", [{ kind: "segment", pattern: '\\nNAME\\s*=\\s*"([^"]+)"' }]);
    assert.equal(found[0]?.name, "Cover");
  });

  it("ignores a broken project pattern", () => {
    assert.doesNotThrow(() => parseSymbols("scene.stop()", "x.py", [{ kind: "segment", pattern: "(" }]));
  });

  it("knows the slide and stop at a line", () => {
    const here = slideAt(symbols, 24);
    assert.equal(here.segment?.name, "Problem");
    assert.equal(here.stopIndex, 1);
    assert.equal(slideAt(symbols, 5).segment, undefined);
  });

  it("evaluates only plain arithmetic", () => {
    assert.equal(evalNumber("4 * 60"), 240);
    assert.equal(evalNumber("1.5 * 60"), 90);
    assert.equal(evalNumber("(2 + 3) * 4 - 2 / 2"), 19);
    assert.equal(evalNumber("os.exit()"), undefined);
    assert.equal(evalNumber("TOTAL"), undefined);
    assert.equal(evalNumber("4 *"), undefined);
  });

  it("finds the scene's variable", () => {
    assert.equal(receiver(["s = Scene()", "s.play([x])", "", "y = 1"], 4), "s");
    assert.equal(receiver(["x = 1"], 1), "scene");
  });

  it("counts columns in UTF-16 like the editor", () => {
    const found = parseSymbols('¿ñ = 1; scene.stop("é")', "x.py");
    assert.equal(found[0].column, 'ñ = 1; scene'.length + 1);
  });
});

describe("script", () => {
  const lines = fs.readFileSync(SCRIPT, "utf8").split(/\r?\n/);

  it("reads stop marks the way Gaanim does", () => {
    assert.equal(mark("[stop]"), "");
    assert.equal(mark("  [stop title] "), "title");
    assert.equal(mark("[stop: question]"), "question");
    assert.equal(mark("[STOP x]"), "x");
    assert.equal(mark("[stopwatch]"), undefined);
    assert.equal(mark("text [stop]"), undefined);
  });

  it("splits sections, skipping comments and author notes", () => {
    const parsed = parseScript(lines);
    assert.equal(parsed.title, 1);
    assert.deepEqual(
      parsed.sections.map((s) => s.name),
      ["Cover", "problem", "Closing"],
    );
    const words = Object.fromEntries(parsed.sections.map((s) => [s.name, s.words]));
    assert.equal(words.Cover, 9, "the dictated comment is not read");
    assert.equal(words.problem, 11, "the ### note is not read");
    assert.equal(words.Closing, 0);
    assert.deepEqual(
      parsed.sections[1].marks.map((m) => m.name),
      ["question", ""],
    );
    assert.equal(parsed.sections[0].text, "Good morning everyone. Today: how sales grew this year.");
  });

  it("matches sections ignoring case, and finds the section of a line", () => {
    const parsed = parseScript(lines);
    assert.equal(findSection(parsed, "Problem")?.name, "problem");
    assert.equal(sectionAt(parsed, 16)?.name, "problem");
    assert.equal(sectionAt(parsed, 2), undefined);
  });

  it("adds a missing section after the slide before it, with its stops", () => {
    const script = ["# Script", "", "## Cover", "Hi.", "", "## Closing", "Bye."];
    const insert = sectionInsert(script, ["Cover", "Problem", "Closing"], "Problem", ["question", ""]);
    const result = [...script.slice(0, insert.at), ...insert.lines, ...script.slice(insert.at)];
    assert.deepEqual(result, [
      "# Script",
      "",
      "## Cover",
      "Hi.",
      "",
      "## Problem",
      "",
      "[stop question]",
      "",
      "[stop]",
      "",
      "## Closing",
      "Bye.",
    ]);
    assert.equal(result[insert.heading - 1], "## Problem");
  });

  it("appends a section for the first slide without a predecessor at the end", () => {
    const script = ["# Script", ""];
    const insert = sectionInsert(script, ["Intro"], "Intro", []);
    const result = [...script.slice(0, insert.at), ...insert.lines];
    assert.deepEqual(result, ["# Script", "", "## Intro", ""]);
    assert.equal(result[insert.heading - 1], "## Intro");
  });

  it("estimates spoken time and pace", () => {
    assert.equal(spoken(150, 150), 60);
    assert.equal(pace(50, 60), "ok");
    assert.equal(pace(65, 60), "tight");
    assert.equal(pace(80, 60), "over");
    assert.equal(pace(80), "none");
  });
});

describe("clock", () => {
  it("formats instants and lengths", () => {
    assert.equal(clock(1.3), "0:01.3");
    assert.equal(clock(75.25), "1:15.3");
    assert.equal(talkClock(42.4), "0:42");
    assert.equal(talkClock(240), "4:00");
    assert.equal(talkClock(3605), "1:00:05");
    assert.equal(span(1, 1), "0:01.0");
    assert.equal(span(0, 0.8), "0:00.0–0:00.8");
    assert.equal(secondsArg(1.25), "1.25");
    assert.equal(secondsArg(3), "3");
    assert.equal(parseDuration("20m"), 1200);
    assert.equal(parseDuration("1h30m"), 5400);
    assert.equal(parseDuration("x"), null);
  });
});

describe("timeline", () => {
  const data = timeline();

  it("finds the timeline among printed objects", () => {
    assert.equal(findTimeline([{ type: "message" }, data, { other: 1 }]), data);
    assert.equal(findTimeline([{ type: "message" }]), undefined);
  });

  it("knows the instant each line stands for", () => {
    assert.equal(pointAt(data, MAIN, 10)?.time, 0.8, "a segment rests at its first stop");
    assert.equal(pointAt(data, MAIN, 13)?.kind, "play");
    assert.equal(pointAt(data, MAIN, 24)?.name, "answer");
    assert.equal(pointAt(data, MAIN, 26)?.time, 1.8, "the nearest line above");
    assert.equal(pointAt(data, MAIN, 5), undefined);
    assert.equal(pointAt(data, "/elsewhere.py", 24), undefined);
  });

  it("compares paths the way both sides spell them", () => {
    assert.equal(pathKey("C:\\talk\\main.py"), pathKey("c:/talk/main.py"));
  });

  it("finds segments by time and declarations by name", () => {
    assert.equal(segmentAt(data, 1.0)?.name, "Problem");
    assert.deepEqual(location(data, "Problem", "question"), { file: data.segments[1].file, line: 23 });
    assert.deepEqual(location(data, "Problem", ""), { file: data.segments[1].file, line: 25 });
    assert.equal(location(data, "Nope"), undefined);
  });

  it("labels lines with their times", () => {
    const labels = lineLabels(data, MAIN);
    assert.deepEqual(labels.get(10), ["▤ 0:00.0–0:00.8 · 0.8s"]);
    assert.deepEqual(labels.get(13), ["▶ 0:00.0–0:00.8"]);
    assert.deepEqual(labels.get(23), ["⏸ 0:01.3"]);
    assert.deepEqual(labels.get(28), ["♪ 0:01.8–0:02.6"]);
  });

  it("describes a line in a hover", () => {
    const lines = hoverLines(data, MAIN, 23);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /stop `question` · 0:01\.3 · 1 of 2 in \*\*Problem\*\*/);
  });

  it("lists plays animating at a time", () => {
    assert.equal(playsAt(data, 0.4).length, 1);
    assert.equal(playsAt(data, 0.8).length, 0);
  });

  it("lists entries in time order, markers and voiceovers among them", () => {
    assert.deepEqual(
      entries(data).map((e) => `${e.kind}:${e.label}`),
      [
        "segment:Cover",
        "stop:title",
        "segment:Problem",
        "stop:question",
        "marker:answer",
        "stop:(stop)",
        "segment:Closing",
        "voiceover:outro",
        "stop:thanks",
      ],
    );
  });
});

describe("check", () => {
  const symbols = parseSymbols(fs.readFileSync(MAIN, "utf8"), MAIN);
  const context: LocateContext = {
    root: ROOT,
    fallback: path.join(ROOT, "gaanim.toml"),
    locate(text) {
      const refs = warningRefs(text);
      if (refs.markdown) {
        return { file: SCRIPT, line: refs.markdown.line };
      }
      const stop = refs.stop && symbols.find((s) => s.kind === "stop" && s.name === refs.stop);
      if (stop) {
        return { file: MAIN, line: stop.line };
      }
      const segment = refs.segment && symbols.find((s) => s.kind === "segment" && s.name === refs.segment);
      return segment ? { file: MAIN, line: segment.line } : undefined;
    },
  };

  it("passes a clean report", () => {
    const report = fromText(
      ["  ▸ check     main.py · presentation", "              3 segments · 4 stops · 4.2 seconds · 16×9", "  ✓ pass      Ready to present"],
      context,
    );
    assert.equal(report.status, "pass");
    assert.equal(report.summary, "Ready to present");
    assert.deepEqual(report.problems, []);
  });

  it("points warnings at the line, stop or segment they name", () => {
    const report = fromText(
      [
        "  ! warning   script.md: section `Intro` (line 3) matches no segment or voiceover",
        "  ! warning   segment `Problem`: mark 1 is [stop q] but stop 1 is `question`",
        "  ! warning   segment `Closing` has no speaker notes",
        "  ! warning   a 16:9 frame is expected",
      ],
      context,
    );
    assert.equal(report.status, "warning");
    assert.deepEqual(
      report.problems.map((p) => [path.basename(p.file), p.line]),
      [
        ["script.md", 3],
        ["main.py", 23],
        ["main.py", 27],
        ["gaanim.toml", 1],
      ],
    );
  });

  it("turns a traceback into an error at the project's frame", () => {
    const report = fromText(
      [
        "  ✗ check     could not load project: Traceback (most recent call last):",
        '  File "<string>", line 3, in <module>',
        '  File "<frozen runpy>", line 287, in run_path',
        `  File "${MAIN}", line 13, in <module>`,
        "    scene.play([title.animate.wrte()])",
        "AttributeError: 'Anim' object has no attribute 'wrte'",
      ],
      context,
    );
    assert.equal(report.status, "error");
    assert.equal(path.normalize(report.problems[0].file), MAIN);
    assert.equal(report.problems[0].line, 13);
    assert.equal(report.problems[0].text, "AttributeError: 'Anim' object has no attribute 'wrte'");
  });

  it("reads JSON diagnostics with their place, and the summary", () => {
    const report = fromJson(
      [
        { type: "diagnostic", level: "warning", message: "segment `Closing` has no speaker notes", file: MAIN, line: 27, column: null },
        { type: "check", result: "pass", segments: 3, stops: 4, duration: 2.8 },
      ],
      [],
      context,
    );
    assert.equal(report.status, "warning");
    assert.equal(report.problems[0].line, 27);
    assert.equal(report.summary, "ready · 3 segments · 4 stops · 2.8 s");
  });

  it("places a JSON error from the traceback inside its message", () => {
    const report = fromJson(
      [
        {
          type: "message",
          level: "error",
          label: "check",
          message: `could not load\nTraceback (most recent call last):\n  File "${MAIN}", line 30, in <module>\nNameError: name 'x' is not defined`,
          file: null,
          line: null,
        },
      ],
      [],
      context,
    );
    assert.equal(report.status, "error");
    assert.equal(report.problems[0].line, 30);
    assert.equal(report.problems[0].text, "NameError: name 'x' is not defined");
  });

  it("splits entries and finds tracebacks", () => {
    assert.equal(checkEntries(["  ✓ pass      ok", "[exit 0]"])[0].more.length, 0);
    assert.equal(traceback(["no frames here", "last words"], ROOT).message, "last words");
  });
});

describe("typst", () => {
  it("finds math in equation strings and $…$", () => {
    assert.deepEqual(
      [scan('scene.text.equation("x^2 + alp')?.math, scan('scene.text.equation("x^2 + alp')?.prefix],
      [true, "alp"],
    );
    assert.equal(scan('scene.text("Area $pi r')?.math, true);
    assert.equal(scan('scene.text("Area $pi$ and ')?.math, false);
    assert.equal(scan('scene.text.equation("x", color="re')?.math, false, "a keyword argument is not math");
    assert.equal(scan("x = 1 # equation(\"a"), undefined, "comments are not strings");
    assert.equal(scan('equation("#let')?.math, false, "#name is Typst code");
  });

  it("knows the call a string is an argument of", () => {
    const context = scan('scene.media.image("lo');
    assert.equal(context?.call, "image");
    assert.equal(context?.content, "lo");
    assert.equal(context?.keyword, false);
  });

  it("offers symbols, functions and variants", () => {
    const top = mathItems("");
    assert.ok(top.some((item) => item.label === "alpha" && item.detail === "α"));
    assert.ok(top.some((item) => item.label === "frac(…)" && item.snippet));
    const arrows = mathItems("arrow.r.");
    assert.ok(arrows.some((item) => item.label === "double" && item.detail === "⇒"));
    assert.ok(mathItems("arrow.").some((item) => item.kind === "accent" && item.label === "l(…)"));
  });

  it("shows blanks and combining marks visibly", () => {
    assert.equal(glyph(" "), "␣");
    assert.equal(glyph("\u0301"), "◌\u0301");
  });
});

describe("nudge", () => {
  it("steps numbers by their own precision", () => {
    assert.equal(step("0.8", 1), "0.9");
    assert.equal(step("0.25", 1), "0.26");
    assert.equal(step("3", -1), "2");
    assert.equal(step("0.1", -1), "0.0");
    assert.equal(step("-0.1", 1), "0.0");
    assert.equal(step("1.", 1), "2.");
  });

  it("finds the number at or after the cursor", () => {
    assert.deepEqual(numberAt("x.move_to(0.5, -2)", 0), { start: 10, end: 13, text: "0.5" });
    assert.deepEqual(numberAt("x.move_to(0.5, -2)", 14), { start: 15, end: 17, text: "-2" });
    assert.deepEqual(numberAt("x-1", 0), { start: 2, end: 3, text: "1" });
    assert.equal(numberAt("v2 = a", 0), undefined, "digits in names are not numbers");
  });
});

describe("assets", () => {
  it("finds file names in asset calls", () => {
    const refs = assetReferences(['logo = scene.media.image("logo.png")', "scene.sfx('pop.wav'); scene.text(\"x.png\")", 'scene.media.svg(f"{n}.svg")']);
    assert.deepEqual(
      refs.map((r) => [r.call, r.name, r.line, r.start, r.end]),
      [
        ["image", "logo.png", 1, 26, 34],
        ["sfx", "pop.wav", 2, 11, 18],
      ],
    );
  });
});

describe("takes", () => {
  it("normalizes words like Gaanim", () => {
    assert.equal(normalizeWord("¿Derivada?"), "derivada");
    assert.equal(normalizeWord("Pendiente,"), "pendiente");
    assert.deepEqual(textWords("Hoy  vemos la DERIVADA."), ["hoy", "vemos", "la", "derivada"]);
    assert.equal(findPhrase(["a", "b", "c", "b"], ["b"], 2), 3);
  });

  it("resolves markers: tapped, transcript, estimated, missing", () => {
    const timing = new TakeTiming(
      true,
      10,
      { markers: { inicio: 0.5 }, words: [{ text: "Hoy", start: 1, end: 1.2 }, { text: "derivada.", start: 2, end: 2.5 }] },
      "Hoy vemos la derivada y su pendiente",
    );
    assert.deepEqual(timing.resolve("inicio"), { source: "tapped", offset: 0.5 });
    assert.deepEqual(timing.resolve("derivada"), { source: "transcript", offset: 2 });
    const estimated = timing.resolve("pendiente");
    assert.equal(estimated.source, "estimated");
    assert.ok(Math.abs((estimated.offset ?? 0) - (10 * 6) / 7) < 1e-9);
    assert.equal(timing.resolve("tangente").source, "missing");
  });

  it("ignores marks and words without a recorded take", () => {
    const timing = new TakeTiming(false, undefined, { markers: { x: 1 } }, "uno dos");
    assert.equal(timing.resolve("x").source, "missing");
    assert.deepEqual(timing.resolve("dos"), { source: "estimated" });
  });

  it("finds the markers each voiceover block asks for", () => {
    const blocks = voiceoverBlocks([
      'with scene.voiceover("intro") as vo:',
      "    scene.play([t.animate.write()])",
      '    vo.wait_until("derivada")',
      '    scene.play([c.animate.create()], duration=vo.until("pendiente"))',
      'print(vo.until("después"))',
      'cierre = scene.voiceover("cierre", text="Y eso es todo por hoy")',
      'scene.play([l.animate.fade_in()], duration=cierre.until("todo"))',
      "cierre.finish()",
      'cierre.wait_until("tarde")',
    ]);
    assert.deepEqual(
      blocks.map((b) => [b.key, b.variable, b.text, b.markers.map((m) => `${m.method}:${m.name}:${m.line}`)]),
      [
        ["intro", "vo", undefined, ["wait_until:derivada:3", "until:pendiente:4"]],
        ["cierre", "cierre", "Y eso es todo por hoy", ["until:todo:7"]],
      ],
    );
    const marker = blocks[0].markers[0];
    assert.equal('    vo.wait_until("derivada")'.slice(marker.start, marker.end), "derivada");
  });
});

describe("caps and toml", () => {
  it("reads what the CLI supports from its help", () => {
    const general = "Commands:\n  inspect <SCRIPT_OR_PROJECT> [--json]\nOptions:\n  --listen <stdio|HOST:PORT>\n  --message-format <FORMAT>";
    assert.deepEqual(parseCaps(general, "--frame <SECONDS|NAME>[,...]"), { listen: true, json: true, inspect: true, names: true });
    assert.deepEqual(parseCaps("", ""), { listen: false, json: false, inspect: false, names: false });
  });

  it("reads gaanim.toml's top-level keys", () => {
    const raw = readTopLevel(fs.readFileSync(path.join(ROOT, "gaanim.toml"), "utf8"));
    assert.deepEqual(raw, { name: "talk", kind: "slides", entry: "main.py", assets_dir: "assets", output_dir: "exports", language: "en-US" });
  });
});

describe("spawn", () => {
  it("quotes arguments for cmd.exe only when they need it", () => {
    assert.equal(cmdQuote("inspect"), "inspect");
    assert.equal(cmdQuote("C:/Users/Ana María/charla"), '"C:/Users/Ana María/charla"');
    assert.equal(cmdQuote(""), '""');
    assert.equal(cmdQuote('say "hi"'), '"say \\"hi\\""');
    assert.equal(cmdQuote("C:\a b\\"), '"C:\a b\\\\"');
    assert.equal(cmdQuote("a&b"), '"a&b"');
  });

  it("starts batch files through the shell, quoted, and the rest directly", () => {
    assert.deepEqual(launch("C:\Program Files\gaanim\gaanim.cmd", ["inspect", "C:\mis charlas\main.py"], "win32"), {
      command: '"C:\Program Files\gaanim\gaanim.cmd"',
      args: ["inspect", '"C:\mis charlas\main.py"'],
      shell: true,
    });
    assert.deepEqual(launch("C:\Tools\gaanim.exe", ["inspect", "a b"], "win32"), {
      command: "C:\Tools\gaanim.exe",
      args: ["inspect", "a b"],
      shell: false,
    });
    assert.deepEqual(launch("/usr/bin/gaanim.cmd", ["a b"], "linux"), { command: "/usr/bin/gaanim.cmd", args: ["a b"], shell: false });
  });
});
