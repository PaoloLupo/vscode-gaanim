// What only Gaanim knows about a scene's Python, next to the Python language server:
// times as inlay hints, lenses over slides, hovers, code actions, the scene's
// structure as symbols, asset and Typst completion, and missing asset warnings.

import * as path from "node:path";
import * as vscode from "vscode";
import * as assets from "./assets";
import { config } from "./config";
import { assetReferences, ASSET_CALLS, formatSize } from "./core/assets";
import { span, talkClock } from "./core/clock";
import { findSection, spoken } from "./core/script";
import { SLIDE_KINDS } from "./core/symbols";
import { hoverLines, lineLabels } from "./core/timeline";
import { mathItems, MathItem, scan } from "./core/typst";
import { previewChanged, scriptChanged, timelineChanged } from "./events";
import * as inspect from "./inspect";
import { readScript, takeFile } from "./narration";
import { loopedSegment } from "./preview";
import { documentSymbols, projectForDocument } from "./project";
import { describe as describeMarker, resolveMarkers } from "./takeInspector";
import * as workspace from "./workspace";

export const SELECTOR: vscode.DocumentSelector = { language: "python", scheme: "file" };

/** The timeline when it describes the document as it is on disk. */
function timelineFor(document: vscode.TextDocument) {
  const project = projectForDocument(document);
  if (!project || document.isDirty) {
    return { project, data: undefined };
  }
  return { project, data: inspect.cached(project) };
}

export class InlayHints implements vscode.InlayHintsProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.changed.event;

  constructor() {
    timelineChanged.event(() => this.changed.fire());
  }

  provideInlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (!config.inlayHints()) {
      return [];
    }
    const { data } = timelineFor(document);
    if (!data) {
      return [];
    }
    const hints: vscode.InlayHint[] = [];
    for (const [line, labels] of lineLabels(data, document.uri.fsPath)) {
      const row = line - 1;
      if (row < range.start.line || row > range.end.line || row >= document.lineCount) {
        continue;
      }
      const hint = new vscode.InlayHint(document.lineAt(row).range.end, labels.join("  "));
      hint.paddingLeft = true;
      hints.push(hint);
    }
    return hints;
  }
}

export class CodeLenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private lastLoop = new Map<string, string | undefined>();

  constructor() {
    timelineChanged.event(() => this.changed.fire());
    scriptChanged.event(() => this.changed.fire());
    previewChanged.event((root) => {
      // Entering, leaving or moving a loop changes the slides' lenses.
      const project = vscode.window.activeTextEditor && projectForDocument(vscode.window.activeTextEditor.document);
      const looped = project && project.root === root ? loopedSegment(project) : undefined;
      if (this.lastLoop.get(root) !== looped) {
        this.lastLoop.set(root, looped);
        this.changed.fire();
      }
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!config.codeLens()) {
      return [];
    }
    const { project, data } = timelineFor(document);
    if (!project) {
      return [];
    }
    const script = readScript(project)?.script;
    const segments = new Map((data?.segments ?? []).map((segment) => [segment.name, segment]));
    const voiceovers = new Map((data?.voiceovers ?? []).map((voiceover) => [voiceover.key, voiceover]));
    const looped = loopedSegment(project);
    const wpm = config.script.wpm();
    const uri = document.uri;
    const lenses: vscode.CodeLens[] = [];
    for (const symbol of documentSymbols(document)) {
      if (!symbol.name || !SLIDE_KINDS.has(symbol.kind)) {
        continue;
      }
      const range = new vscode.Range(symbol.line - 1, 0, symbol.line - 1, 0);
      const lens = (title: string, command: string, args: unknown[], tooltip?: string) =>
        lenses.push(new vscode.CodeLens(range, { title, command, arguments: args, tooltip }));
      const section = script && findSection(script, symbol.name);
      if (symbol.kind === "voiceover") {
        const recorded = takeFile(project, symbol.name);
        const measured = voiceovers.get(symbol.name);
        const length = measured ? ` ${talkClock(measured.end - measured.start)}` : "";
        lens(recorded ? `$(mic-filled) take${length}` : `$(mic) no take yet${length ? ` · ≈${length.trim()}` : ""}`, "gaanim.lens.script", [uri, symbol.line],
          recorded ? `Recorded in ${path.basename(recorded)}` : "Record it in Gaanim's narration panel");
        lens("$(play) Preview", "gaanim.lens.preview", [uri, symbol.line]);
        if (!section) {
          lens("$(book) Write text", "gaanim.lens.script", [uri, symbol.line]);
        }
        continue;
      }
      lens("$(play) Preview", "gaanim.lens.preview", [uri, symbol.line], "Move the preview to this slide");
      if (looped === symbol.name) {
        lens("$(sync-ignored) Unloop", "gaanim.lens.loop", ["off"], "Stop looping this slide");
      } else {
        lens("$(sync) Loop", "gaanim.lens.loop", [symbol.name], "Play this slide over and over, across reloads");
      }
      lens("$(device-camera) Still", "gaanim.lens.still", [uri, symbol.line], "Export the PNG of this slide");
      if (section) {
        const seconds = spoken(section.words, wpm);
        const target = symbol.target !== undefined ? ` / ${talkClock(symbol.target)}` : "";
        lens(`$(book) ≈${talkClock(seconds)}${target}`, "gaanim.lens.script", [uri, symbol.line], "How long its script takes to say; open it");
      } else {
        lens("$(book) Write script", "gaanim.lens.script", [uri, symbol.line], "Add its section to the narration script");
      }
      const segment = segments.get(symbol.name);
      if (segment) {
        lens(`$(clock) ${span(segment.start, segment.end)}`, "gaanim.lens.seek", [symbol.name], "Move the preview here");
      }
    }
    return lenses;
  }
}

export class Hover implements vscode.HoverProvider {
  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const { project, data } = timelineFor(document);
    if (!project) {
      return undefined;
    }
    const parts: string[] = [];
    if (data) {
      const lines = hoverLines(data, document.uri.fsPath, position.line + 1);
      if (lines.length > 0) {
        parts.push(`**Timeline**\n\n${lines.join("  \n")}`);
      }
    }
    const line = document.lineAt(position.line).text;
    const ref = assetReferences([line]).find((candidate) => position.character >= candidate.start && position.character <= candidate.end);
    if (ref) {
      const file = assets.resolve(project, ref.name);
      parts.push(file ? `**Asset**\n\n${await assets.describe(project, file)}` : `**Asset** \`${ref.name}\` not found`);
    }
    if (/\.(wait_until|until)\(/.test(line)) {
      const markers = await resolveMarkers(document, project);
      const marker = markers.find(
        (candidate) =>
          candidate.call.line === position.line + 1 && position.character >= candidate.call.start && position.character <= candidate.call.end,
      );
      if (marker) {
        parts.push(describeMarker(marker));
      }
    }
    return parts.length > 0 ? new vscode.Hover(new vscode.MarkdownString(parts.join("\n\n---\n\n"))) : undefined;
  }
}

export class CodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const project = projectForDocument(document);
    if (!project) {
      return [];
    }
    const line = range.start.line + 1;
    const at = [document.uri, line];
    const actions: vscode.CodeAction[] = [];
    const action = (title: string, kind: vscode.CodeActionKind, command: string, args: unknown[] = at) => {
      const item = new vscode.CodeAction(title, kind);
      item.command = { title, command, arguments: args };
      actions.push(item);
    };
    const script = readScript(project)?.script;
    for (const symbol of documentSymbols(document)) {
      if (symbol.line !== line) {
        continue;
      }
      if ((symbol.kind === "segment" || symbol.kind === "voiceover") && symbol.name) {
        if (!script || !findSection(script, symbol.name)) {
          action(`Write the ${symbol.kind === "segment" ? "script" : "text"} of “${symbol.name}”`, vscode.CodeActionKind.QuickFix, "gaanim.lens.script");
        } else {
          action(`Open the script of “${symbol.name}”`, vscode.CodeActionKind.Empty, "gaanim.lens.script");
        }
      } else if (symbol.kind === "stop" && !symbol.name) {
        action("Name this stop", vscode.CodeActionKind.QuickFix, "gaanim.action.nameStop");
      }
    }
    if (context.diagnostics.some((diagnostic) => diagnostic.message.includes("no speaker notes"))) {
      action("Write the speaker notes in the script", vscode.CodeActionKind.QuickFix, "gaanim.lens.script");
    }
    if (context.only && !context.only.contains(vscode.CodeActionKind.Empty) && !vscode.CodeActionKind.Empty.contains(context.only)) {
      return actions;
    }
    action("Gaanim: Preview this line", vscode.CodeActionKind.Empty, "gaanim.lens.preview");
    action("Gaanim: Export the frame of this line", vscode.CodeActionKind.Empty, "gaanim.lens.still");
    action("Gaanim: Export this slide as a draft MP4", vscode.CodeActionKind.Empty, "gaanim.action.exportSlide");
    action("Gaanim: Add a marker below", vscode.CodeActionKind.Empty, "gaanim.action.addMarker");
    return actions;
  }
}

const SYMBOL_KINDS: Record<string, vscode.SymbolKind> = {
  segment: vscode.SymbolKind.Module,
  section: vscode.SymbolKind.Namespace,
  stop: vscode.SymbolKind.Event,
  marker: vscode.SymbolKind.Key,
  voiceover: vscode.SymbolKind.Event,
};

export class DocumentSymbols implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const { project, data } = timelineFor(document);
    if (!project) {
      return [];
    }
    const times = data ? lineLabels(data, document.uri.fsPath) : new Map<number, string[]>();
    const symbols: vscode.DocumentSymbol[] = [];
    let parent: vscode.DocumentSymbol | undefined;
    const close = (row: number) => {
      if (parent) {
        parent.range = new vscode.Range(parent.range.start, document.lineAt(Math.max(row - 1, parent.range.start.line)).range.end);
      }
    };
    for (const symbol of documentSymbols(document)) {
      const kind = SYMBOL_KINDS[symbol.kind];
      if (kind === undefined) {
        continue;
      }
      const row = symbol.line - 1;
      const lineRange = document.lineAt(row).range;
      const item = new vscode.DocumentSymbol(
        symbol.name ?? `(${symbol.kind})`,
        times.get(symbol.line)?.join("  ") ?? symbol.kind,
        kind,
        lineRange,
        lineRange,
      );
      if (symbol.kind === "segment" || symbol.kind === "section") {
        close(row);
        parent = item;
        symbols.push(item);
      } else if (parent) {
        parent.children.push(item);
      } else {
        symbols.push(item);
      }
    }
    close(document.lineCount);
    return symbols;
  }
}

const MATH_KINDS: Record<MathItem["kind"], vscode.CompletionItemKind> = {
  symbol: vscode.CompletionItemKind.Constant,
  function: vscode.CompletionItemKind.Function,
  accent: vscode.CompletionItemKind.Function,
  operator: vscode.CompletionItemKind.Operator,
  space: vscode.CompletionItemKind.Value,
};

export class Completion implements vscode.CompletionItemProvider {
  static readonly triggers = [".", '"', "'", "/", "$"];

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] | undefined {
    const project = projectForDocument(document);
    if (!project) {
      return undefined;
    }
    const context = scan(document.getText(new vscode.Range(new vscode.Position(0, 0), position)));
    if (!context) {
      return undefined;
    }
    if (context.math) {
      if (!config.typst()) {
        return undefined;
      }
      const range = new vscode.Range(position.translate(0, -(context.prefix.length - context.prefix.lastIndexOf(".") - 1)), position);
      return mathItems(context.prefix).map((item) => {
        const completion = new vscode.CompletionItem({ label: item.label, description: item.detail }, MATH_KINDS[item.kind]);
        completion.insertText = item.snippet ? new vscode.SnippetString(item.insertText) : item.insertText;
        completion.filterText = item.filterText ?? item.label;
        completion.documentation = new vscode.MarkdownString(item.documentation);
        completion.range = range;
        completion.sortText = `${item.kind === "symbol" ? "1" : "0"}${item.label}`;
        return completion;
      });
    }
    const extensions = context.call ? ASSET_CALLS[context.call] : undefined;
    if (extensions === undefined || context.keyword || context.content.includes("\n")) {
      return undefined;
    }
    // Replace everything typed in the string so far with the whole name.
    const range = new vscode.Range(position.translate(0, -context.content.length), position);
    const found = assets.files(project, extensions);
    if (found.length === 0) {
      const empty = new vscode.CompletionItem(`(no matching files in ${path.basename(project.assetsDir)}/)`, vscode.CompletionItemKind.Folder);
      empty.insertText = context.content;
      empty.range = range;
      return [empty];
    }
    const owner = found.some((file) => file.shared) ? workspace.of(project.root) : undefined;
    return found.map((file) => {
      const completion = new vscode.CompletionItem(
        { label: file.name, description: file.shared ? `shared · ${formatSize(file.size)}` : formatSize(file.size) },
        vscode.CompletionItemKind.File,
      );
      completion.range = range;
      completion.filterText = file.name;
      // The project's own files first.
      completion.sortText = `${file.shared ? "1" : "0"}${file.name}`;
      const shown = file.shared && owner ? path.relative(owner.root, file.path) : path.relative(project.root, file.path);
      completion.documentation = new vscode.MarkdownString(
        `\`${shown}\`${file.shared ? `\n\nShared by the workspace${owner ? ` ${owner.name}` : ""}` : ""}`,
      );
      return completion;
    });
  }
}

export const assetDiagnostics = vscode.languages.createDiagnosticCollection("gaanim-assets");

/** Warnings for asset names that resolve to no file. */
export function publishAssets(document: vscode.TextDocument): void {
  if (document.languageId !== "python" || document.uri.scheme !== "file") {
    return;
  }
  const project = projectForDocument(document);
  if (!project || !config.assetDiagnostics()) {
    assetDiagnostics.delete(document.uri);
    return;
  }
  const list: vscode.Diagnostic[] = [];
  const shared = assets.sharedBases(project);
  const where = path.relative(project.root, project.assetsDir) || ".";
  for (const ref of assetReferences(document.getText().split(/\r?\n/))) {
    if (!assets.resolve(project, ref.name)) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(ref.line - 1, ref.start, ref.line - 1, ref.end),
        `${ref.call}: no file named “${ref.name}” in ${where}${shared.length > 0 ? " or the workspace's shared assets" : ""}`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = "gaanim";
      list.push(diagnostic);
    }
  }
  assetDiagnostics.set(document.uri, list);
}
