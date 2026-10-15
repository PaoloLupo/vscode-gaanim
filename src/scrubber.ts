// The preview's timeline as a bar in the panel: slides, stops, markers and
// voiceovers to scale, the playhead, and the preview's controls. A click
// moves the preview there; Alt+click loops the slide.

import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { previewChanged, timelineChanged } from "./events";
import * as inspect from "./inspect";
import * as live from "./live";
import { following, loop, seek, status } from "./preview";
import { openAt } from "./editorLink";
import { currentProject } from "./project";

type Message =
  | { type: "seek"; time: number }
  | { type: "loop"; segment: string }
  | { type: "go"; file: string; line: number }
  | { type: "command"; command: string }
  | { type: "ready" };

export class Scrubber implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor() {
    timelineChanged.event(() => this.post());
    previewChanged.event(() => this.post());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false };
    view.webview.html = html(crypto.randomBytes(16).toString("base64"), view.webview.cspSource);
    view.webview.onDidReceiveMessage((message: Message) => this.receive(message));
    view.onDidChangeVisibility(() => this.post());
    view.onDidDispose(() => (this.view = undefined));
  }

  private receive(message: Message): void {
    const project = currentProject();
    switch (message.type) {
      case "ready":
        this.post();
        break;
      case "seek":
        void seek(message.time, project);
        break;
      case "loop":
        void loop(message.segment, project);
        break;
      case "go":
        void openAt(message.file, message.line);
        break;
      case "command":
        if (message.command.startsWith("gaanim.")) {
          void vscode.commands.executeCommand(message.command);
        }
        break;
    }
  }

  /** Sends the current project's timeline and preview state to the bar. */
  post(): void {
    if (!this.view?.visible) {
      return;
    }
    const project = currentProject();
    const preview = project && status.get(project.root);
    const data = project && inspect.cached(project);
    void this.view.webview.postMessage({
      type: "state",
      project: project?.name,
      timeline: data ?? null,
      stale: project ? inspect.isStale(project) : false,
      state: preview?.state ?? "closed",
      detail: preview?.detail,
      listen: preview?.listen ?? false,
      playhead: preview?.playhead ?? null,
      following: project ? following.has(project.root) : false,
      live: project ? live.active(project.root) : false,
    });
  }
}

function html(nonce: string, csp: string): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  /* Gaanim's palette (docs/assets/brand in the Gaanim repository). The current frame, here the playhead, is gold on dark and ink on light. */
  body { --gaanim-frame: #7C6CFF; --gaanim-accent: #A99FFF; --gaanim-on-accent: #14112E; --gaanim-gold: #FFC933; --gaanim-now: #FFC933; }
  body.vscode-light, body.vscode-high-contrast-light { --gaanim-accent: #5B4AF0; --gaanim-on-accent: #FFFFFF; --gaanim-gold: #F0A800; --gaanim-now: #14112E; }
  body { --line: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); margin: 0; padding: 6px 10px 10px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; }
  header { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
  button { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); background: transparent; color: var(--vscode-foreground); padding: 2px 8px; border-radius: 0; cursor: pointer; font: inherit; }
  button:hover { background: color-mix(in srgb, var(--gaanim-frame) 14%, transparent); }
  button.on { background: var(--gaanim-accent); border-color: var(--gaanim-accent); color: var(--gaanim-on-accent); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .readout { font-family: var(--vscode-editor-font-family); font-size: 12px; font-variant-numeric: tabular-nums; margin-left: auto; opacity: .85; }
  .state-failed { color: var(--vscode-errorForeground); }
  .track { position: relative; height: 60px; background: var(--vscode-editorWidget-background); border: 1px solid var(--line); cursor: pointer; overflow: hidden; user-select: none; }
  .track::before { content: ""; position: absolute; left: 0; right: 0; top: 41px; height: 1px; background: var(--line); }
  .seg { position: absolute; top: 0; height: 28px; box-sizing: border-box; padding: 7px 6px 0; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--gaanim-frame) 8%, transparent); font: 11px var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .75; }
  .seg::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--gaanim-frame); opacity: .4; }
  .seg.current { background: color-mix(in srgb, var(--gaanim-frame) 22%, transparent); opacity: 1; }
  .seg.current::before { height: 3px; opacity: 1; }
  .stop { position: absolute; top: 38px; width: 7px; height: 7px; margin-left: -3px; background: var(--gaanim-accent); }
  .marker { position: absolute; top: 38px; width: 5px; height: 5px; margin-left: -3px; border: 1.5px solid var(--gaanim-accent); transform: rotate(45deg); background: var(--vscode-editorWidget-background); }
  .vo { position: absolute; top: 51px; height: 4px; background: color-mix(in srgb, var(--gaanim-accent) 45%, transparent); }
  .loop { position: absolute; top: 0; bottom: 0; box-sizing: border-box; border-left: 2px solid var(--gaanim-gold); border-right: 2px solid var(--gaanim-gold); background: color-mix(in srgb, var(--gaanim-gold) 8%, transparent); pointer-events: none; }
  .playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--gaanim-now); pointer-events: none; }
  .playhead::before { content: ""; position: absolute; top: 0; left: -3px; width: 8px; height: 8px; background: var(--gaanim-now); }
  .hover { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--vscode-foreground); opacity: .3; pointer-events: none; display: none; }
  .empty { opacity: .75; padding: 8px 0; }
  .legend { margin-top: 6px; font-size: 11px; opacity: .6; }
</style>
</head>
<body>
<header>
  <button id="toggle" title="Play or pause the preview">▶ Play</button>
  <button id="loop" title="Loop the slide at the playhead">⟲ Loop</button>
  <button id="follow" title="The preview follows the cursor">⇄ Follow</button>
  <button id="live" title="Save as you type so the preview shows each change">● Live</button>
  <button id="still" title="Export the PNG of the cursor's line">▣ Still</button>
  <span id="readout" class="readout"></span>
</header>
<div id="body"></div>
<div class="legend">Click: move the preview · Alt+click: loop that slide · Double-click: go to its code</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let model = null;
  const $ = (id) => document.getElementById(id);
  const clock = (s) => { const m = Math.floor(s / 60); return m + ":" + (s - m * 60).toFixed(1).padStart(4, "0"); };
  const command = (name) => vscode.postMessage({ type: "command", command: name });
  $("toggle").onclick = () => command(model && model.state !== "closed" ? "gaanim.togglePlay" : "gaanim.previewHere");
  $("loop").onclick = () => command("gaanim.loop");
  $("follow").onclick = () => command("gaanim.follow");
  $("live").onclick = () => command("gaanim.live");
  $("still").onclick = () => command("gaanim.still");
  function segmentAt(t) {
    let found = null;
    for (const s of model.timeline.segments) if (s.start <= t + 1e-6) found = s;
    return found;
  }
  function render() {
    const body = $("body");
    if (!model || !model.project) { body.innerHTML = '<div class="empty">Open a Gaanim script to see its timeline.</div>'; $("readout").textContent = ""; return; }
    const playing = model.playhead && model.playhead.playing;
    $("toggle").textContent = model.state === "closed" ? "▶ Preview" : playing ? "⏸ Pause" : "▶ Play";
    $("loop").classList.toggle("on", Boolean(model.playhead && model.playhead.loop));
    $("follow").classList.toggle("on", model.following);
    $("live").classList.toggle("on", model.live);
    const readout = $("readout");
    readout.className = "readout" + (model.state === "failed" ? " state-failed" : "");
    const where = model.playhead ? [model.playhead.segment, model.playhead.stop].filter(Boolean).join(" · ") : "";
    readout.textContent = model.state === "failed" ? "✗ " + (model.detail || "failed")
      : model.playhead ? clock(model.playhead.time) + (model.timeline ? " / " + clock(model.timeline.duration) : "") + (where ? "  " + where : "")
      : model.state === "closed" ? model.project + (model.timeline ? " · " + clock(model.timeline.duration) : "")
      : model.state + "…";
    const t = model.timeline;
    if (!t || !t.duration) {
      body.innerHTML = '<div class="empty">' + (model.stale ? "Times appear once the scene runs: open the preview or save the script." : "No timeline yet.") + "</div>";
      return;
    }
    const pct = (s) => (Math.max(0, Math.min(s, t.duration)) / t.duration * 100) + "%";
    const track = document.createElement("div");
    track.className = "track";
    const current = model.playhead ? segmentAt(model.playhead.time) : null;
    for (const s of t.segments) {
      const el = document.createElement("div");
      el.className = "seg" + (current && current.name === s.name ? " current" : "");
      el.style.left = pct(s.start);
      el.style.width = "calc(" + pct(s.end - s.start) + ")";
      el.textContent = s.name;
      el.title = s.name + " · " + clock(s.start) + "–" + clock(s.end);
      track.appendChild(el);
      for (const stop of s.stops || []) {
        const tick = document.createElement("div");
        tick.className = "stop";
        tick.style.left = pct(stop.time);
        tick.title = "stop " + (stop.name || "") + " · " + clock(stop.time);
        track.appendChild(tick);
      }
    }
    for (const m of t.markers || []) {
      const el = document.createElement("div");
      el.className = "marker"; el.style.left = pct(m.time); el.title = "marker " + m.name + " · " + clock(m.time);
      track.appendChild(el);
    }
    for (const v of t.voiceovers || []) {
      const el = document.createElement("div");
      el.className = "vo"; el.style.left = pct(v.start); el.style.width = pct(v.end - v.start); el.title = "voiceover " + v.key + " · " + clock(v.start) + "–" + clock(v.end);
      track.appendChild(el);
    }
    if (model.playhead && model.playhead.loop) {
      const el = document.createElement("div");
      el.className = "loop"; el.style.left = pct(model.playhead.loop[0]); el.style.width = pct(model.playhead.loop[1] - model.playhead.loop[0]);
      track.appendChild(el);
    }
    if (model.playhead) {
      const el = document.createElement("div");
      el.className = "playhead"; el.style.left = pct(model.playhead.time);
      track.appendChild(el);
    }
    const hover = document.createElement("div");
    hover.className = "hover";
    track.appendChild(hover);
    const timeAt = (event) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * t.duration; };
    track.onmousemove = (event) => { const r = track.getBoundingClientRect(); hover.style.display = "block"; hover.style.left = (event.clientX - r.left) + "px"; track.title = clock(timeAt(event)); };
    track.onmouseleave = () => { hover.style.display = "none"; };
    track.onclick = (event) => {
      const time = timeAt(event);
      const s = segmentAt(time);
      if (event.altKey && s) vscode.postMessage({ type: "loop", segment: s.name });
      else vscode.postMessage({ type: "seek", time: Math.round(time * 1000) / 1000 });
    };
    track.ondblclick = (event) => {
      const s = segmentAt(timeAt(event));
      if (s && s.file && s.line) vscode.postMessage({ type: "go", file: s.file, line: s.line });
    };
    body.replaceChildren(track);
  }
  window.addEventListener("message", (event) => { if (event.data.type === "state") { model = event.data; render(); } });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
