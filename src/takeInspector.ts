// Where each `vo.wait_until("…")` lands in its take, as diagnostics and hovers.

import * as fs from "node:fs";
import * as vscode from "vscode";
import { audioDuration } from "./assets";
import { config } from "./config";
import { findSection } from "./core/script";
import { MarkerCall, Resolution, TakeTiming, voiceoverBlocks } from "./core/takes";
import * as inspect from "./inspect";
import { readScript, readSidecar, takeFile } from "./narration";
import { Project, projectForDocument } from "./project";

export const diagnostics = vscode.languages.createDiagnosticCollection("gaanim-takes");

export interface ResolvedMarker {
  call: MarkerCall;
  key: string;
  resolution: Resolution;
  recorded: boolean;
  transcribed: boolean;
}

const durations = new Map<string, { mtime: number; seconds?: number }>();

async function takeSeconds(project: Project, key: string, file: string): Promise<number | undefined> {
  // With a take on disk, the timeline's voiceover lasts as long as the take.
  const measured = inspect.cached(project)?.voiceovers?.find((voiceover) => voiceover.key === key);
  if (measured && !inspect.isStale(project)) {
    return measured.end - measured.start;
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = durations.get(file);
  if (cached && cached.mtime === mtime) {
    return cached.seconds;
  }
  const seconds = (await audioDuration(file)) ?? (measured ? measured.end - measured.start : undefined);
  // Without ffprobe or a timeline the length stays unknown: sources still resolve, offsets do not.
  durations.set(file, { mtime, seconds });
  return seconds;
}

/** Every marker a document's voiceovers ask for, resolved the way Gaanim does. */
export async function resolveMarkers(document: vscode.TextDocument, project: Project): Promise<ResolvedMarker[]> {
  const blocks = voiceoverBlocks(document.getText().split(/\r?\n/));
  if (blocks.length === 0) {
    return [];
  }
  const script = readScript(project)?.script;
  const out: ResolvedMarker[] = [];
  for (const block of blocks) {
    if (block.markers.length === 0) {
      continue;
    }
    const file = takeFile(project, block.key);
    const seconds = file ? await takeSeconds(project, block.key, file) : undefined;
    const text = block.text ?? (script ? findSection(script, block.key)?.text : undefined);
    const timing = new TakeTiming(file !== undefined, seconds, file ? readSidecar(project, block.key) : {}, text);
    for (const call of block.markers) {
      out.push({
        call,
        key: block.key,
        resolution: timing.resolve(call.name),
        recorded: timing.recorded,
        transcribed: timing.transcribed,
      });
    }
  }
  return out;
}

function message(marker: ResolvedMarker): { text: string; severity: vscode.DiagnosticSeverity } | undefined {
  const name = `“${marker.call.name}”`;
  if (marker.resolution.source === "missing") {
    const where = marker.recorded ? "the take's marks, its transcript or the script" : "the script";
    return {
      text: `${name} is not in ${where} of “${marker.key}”: the scene does not wait here.`,
      severity: vscode.DiagnosticSeverity.Warning,
    };
  }
  if (marker.resolution.source === "estimated" && marker.recorded) {
    const why = marker.transcribed ? "is not in the take's transcript" : "has no transcript to match (the take is not transcribed)";
    const at = marker.resolution.offset !== undefined ? ` (≈${marker.resolution.offset.toFixed(2)} s into the take)` : "";
    return {
      text: `${name} ${why}: it lands at its proportional place in the script${at}.`,
      severity: vscode.DiagnosticSeverity.Information,
    };
  }
  return undefined;
}

/** Describes a marker for a hover. */
export function describe(marker: ResolvedMarker): string {
  const offset = marker.resolution.offset !== undefined ? ` at ${marker.resolution.offset.toFixed(2)} s into the take` : "";
  const sources: Record<string, string> = {
    tapped: `tapped while recording${offset}`,
    transcript: `heard in the transcript${offset}`,
    estimated: marker.recorded
      ? `estimated from the script${offset}`
      : "estimated from the script until the take is recorded",
    missing: "not found: the scene does not wait",
  };
  return `**Take marker** \`${marker.call.name}\` in \`${marker.key}\`: ${sources[marker.resolution.source]}`;
}

/** Refreshes the take diagnostics of a document. */
export async function publish(document: vscode.TextDocument): Promise<void> {
  if (document.languageId !== "python" || document.uri.scheme !== "file") {
    return;
  }
  const project = projectForDocument(document);
  if (!project || !config.takeDiagnostics()) {
    diagnostics.delete(document.uri);
    return;
  }
  const markers = await resolveMarkers(document, project);
  const list: vscode.Diagnostic[] = [];
  for (const marker of markers) {
    const found = message(marker);
    if (found) {
      const range = new vscode.Range(marker.call.line - 1, marker.call.start, marker.call.line - 1, marker.call.end);
      const diagnostic = new vscode.Diagnostic(range, found.text, found.severity);
      diagnostic.source = "gaanim";
      list.push(diagnostic);
    }
  }
  diagnostics.set(document.uri, list);
}
