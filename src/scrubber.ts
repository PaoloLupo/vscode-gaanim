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
  body { margin: 0; padding: 6px 10px 10px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; }
  header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  button { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 2px 8px; border-radius: 3px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .readout { font-variant-numeric: tabular-nums; margin-left: auto; opacity: .85; }
  .state-failed { color: var(--vscode-errorForeground); }
  .track { position: relative; height: 54px; border-radius: 4px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); cursor: pointer; overflow: hidden; user-select: none; }
  .seg { position: absolute; top: 0; height: 30px; box-sizing: border-box; border-right: 1px solid var(--vscode-editor-background); padding: 3px 5px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--vscode-charts-blue); color: var(--vscode-editor-background); opacity: .55; }
  .seg:nth-child(even) { opacity: .4; }
  .seg.current { opacity: .9; }
  .stop, .marker { position: absolute; top: 30px; width: 0; height: 10px; border-left: 2px solid var(--vscode-charts-orange); }
  .marker { border-left-color: var(--vscode-charts-purple); height: 14px; }
  .vo { position: absolute; top: 44px; height: 6px; border-radius: 3px; background: var(--vscode-charts-green); opacity: .7; }
  .loop { position: absolute; top: 0; bottom: 0; background: var(--vscode-charts-yellow); opacity: .18; pointer-events: none; }
  .playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--vscode-editorCursor-foreground, var(--vscode-foreground)); pointer-events: none; }
  .hover { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--vscode-foreground); opacity: .3; pointer-events: none; display: none; }
  .empty { opacity: .75; padding: 8px 0; }
  .legend { margin-top: 6px; font-size: 11px; opacity: .7; }
</style>
</head>
<body>
<header>
  <button id="toggle" title="Play or pause the preview">▶ Play</button>
  <button id="loop" title="Loop the slide at the playhead">⟲ Loop</button>
  <button id="follow" title="The preview follows the cursor">⇄ Follow</button>
  <button id="live" title="Save as you type so the preview shows each change">⚡ Live</button>
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
