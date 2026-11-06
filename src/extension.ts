import * as vscode from 'vscode';
import { Analyzer, EmptySymbolsError, Marker, Target } from './analyzer';
import { WorkspaceCache } from './cache';

interface DocState {
  version: number;
  markers: Marker[];
  /** Duration of the analysis in ms (diagnostics) */
  ms?: number;
}

const OPEN_CMD = 'intellijNav.open';
const PICK_CMD = 'intellijNav.pick';
const MAX_HOVER_LINKS = 6;

/** Public API (used by the integration tests; handy for other extensions too). */
export interface IntellijNavApi {
  markers(uri: vscode.Uri): Marker[] | undefined;
  /** Markers together with the document version they were computed for. */
  markersInfo(uri: vscode.Uri): { version: number; markers: Marker[]; ms?: number } | undefined;
}

export function activate(context: vscode.ExtensionContext): IntellijNavApi {
  const controller = new Controller();
  context.subscriptions.push(controller);
  return { markers: uri => controller.markersFor(uri), markersInfo: uri => controller.markersInfo(uri) };
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

class Controller implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Invisible decoration that only carries the hover popup on the member name. */
  private readonly hoverType = vscode.window.createTextEditorDecorationType({});
  private readonly state = new Map<string, DocState>();
  /** Markers found so far by a running analysis (rendered progressively). */
  private readonly partial = new Map<string, DocState>();
  private readonly pending = new Map<string, vscode.CancellationTokenSource>();
  /** Document version each running analysis works on (avoids starting the same analysis twice). */
  private readonly computing = new Map<string, number>();
  private readonly cache = new WorkspaceCache();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly retries = new Map<string, number>();
  private readonly output = vscode.window.createOutputChannel('IntelliJ Java/Kotlin Navigation');
  private readonly inlayChanged = new vscode.EventEmitter<void>();
  /** Last mouse selection, used to tell a line-number click apart from a triple-click in the text. */
  private lastMouseSel?: { uri: string; line: number; time: number; fullLine: boolean };

  constructor() {
    this.disposables.push(
      this.output,
      this.hoverType,
      vscode.commands.registerCommand(OPEN_CMD, (t: Target) => openTarget(t)),
      vscode.commands.registerCommand(PICK_CMD, (arg: { title: string; targets: Target[] }) => pickTarget(arg.title, arg.targets)),
      vscode.commands.registerCommand('intellijNav.goToImplementations', () => this.navigateFromCursor('down')),
      vscode.commands.registerCommand('intellijNav.goToSuper', () => this.navigateFromCursor('up')),
      vscode.commands.registerCommand('intellijNav.refresh', () => {
        this.cache.clear();
        this.refreshAll(true);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll(false)),
      vscode.window.onDidChangeActiveTextEditor(e => e && this.schedule(e.document, 0)),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (!this.isRelevant(e.document) || !e.contentChanges.length) return;
        const key = e.document.uri.toString();
        // results of other files may depend on this one; stop work on the outdated version right away
        this.cache.documentChanged(e.document.uri);
        this.pending.get(key)?.cancel();
        this.schedule(e.document, this.config().get<number>('refreshDelay', 1000));
      }),
      // A save anywhere can change the hierarchy of the files on screen → recompute visible editors
      vscode.workspace.onDidSaveTextDocument(d => {
        if (this.isRelevant(d)) {
          this.state.clear();
          this.refreshAll(false);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(d => this.forget(d.uri.toString())),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('intellijNav')) {
          this.cache.clear();
          this.refreshAll(true);
          this.inlayChanged.fire();
        }
      }),
      this.inlayChanged,
      vscode.languages.registerInlayHintsProvider(
        [{ language: 'java' }, { language: 'kotlin' }],
        { onDidChangeInlayHints: this.inlayChanged.event, provideInlayHints: (doc, range) => this.inlayHints(doc, range) },
      ),
      vscode.languages.registerCodeLensProvider(
        [{ language: 'java' }, { language: 'kotlin' }],
        { onDidChangeCodeLenses: this.inlayChanged.event, provideCodeLenses: doc => this.codeLenses(doc) },
      ),
      vscode.window.onDidChangeTextEditorSelection(e => this.onSelection(e)),
    );
    // Files changed outside the editor (git checkout, build, other tools)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{java,kt,kts}');
    const external = (uri: vscode.Uri) => this.cache.documentChanged(uri);
    this.disposables.push(watcher, watcher.onDidCreate(external), watcher.onDidChange(external), watcher.onDidDelete(external));
    this.refreshAll(false);
  }

  markersFor(uri: vscode.Uri): Marker[] | undefined {
    return this.state.get(uri.toString())?.markers;
  }

  markersInfo(uri: vscode.Uri): { version: number; markers: Marker[]; ms?: number } | undefined {
    const st = this.state.get(uri.toString());
    return st && { version: st.version, markers: st.markers, ms: st.ms };
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const c of this.pending.values()) c.cancel();
    for (const d of this.disposables) d.dispose();
  }

  private config() {
    return vscode.workspace.getConfiguration('intellijNav');
  }

  private isRelevant(doc: vscode.TextDocument): boolean {
    if (!this.config().get<boolean>('enabled', true)) return false;
    if (doc.uri.scheme === 'output' || doc.uri.scheme === 'git') return false;
    return this.config().get<string[]>('languages', ['java', 'kotlin']).includes(doc.languageId);
  }

  private refreshAll(force: boolean): void {
    if (force) this.state.clear();
    for (const e of vscode.window.visibleTextEditors) {
      if (this.isRelevant(e.document)) this.schedule(e.document, 0);
      else this.clear(e);
    }
  }

  private forget(key: string): void {
    this.state.delete(key);
    this.partial.delete(key);
    this.pending.get(key)?.cancel();
    this.pending.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.retries.delete(key);
  }

  private schedule(doc: vscode.TextDocument, delay: number): void {
    if (!this.isRelevant(doc)) {
      for (const e of editorsFor(doc)) this.clear(e);
      return;
    }
    const key = doc.uri.toString();
    const cached = this.state.get(key);
    if (cached && cached.version === doc.version) {
      for (const e of editorsFor(doc)) this.render(e, cached.markers);
      return;
    }
    if (this.computing.get(key) === doc.version) return; // already being analysed
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => void this.compute(doc), delay),
    );
  }

  /** Complete result for the current version, else the partial one of a running analysis. */
  private current(doc: vscode.TextDocument): Marker[] | undefined {
    const key = doc.uri.toString();
    const st = this.state.get(key);
    if (st && st.version === doc.version) return st.markers;
    const pt = this.partial.get(key);
    if (pt && pt.version === doc.version) return pt.markers;
    return undefined;
  }

  /** Line in the middle of the visible area of the (first) editor showing `doc`. */
  private focusLine(doc: vscode.TextDocument): number | undefined {
    const editor = vscode.window.activeTextEditor?.document === doc ? vscode.window.activeTextEditor : editorsFor(doc)[0];
    const r = editor?.visibleRanges[0];
    return r ? Math.floor((r.start.line + r.end.line) / 2) : undefined;
  }

  private async compute(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    this.pending.get(key)?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.pending.set(key, cts);
    const version = doc.version;
    this.computing.set(key, version);
    const started = Date.now();
    let partialTimer: NodeJS.Timeout | undefined;
    try {
      const onPartial = (found: Marker[]) => {
        if (partialTimer || cts.token.isCancellationRequested) return;
        // throttle: show what we have every 150 ms while the analysis is still running
        partialTimer = setTimeout(() => {
          partialTimer = undefined;
          if (cts.token.isCancellationRequested || doc.version !== version) return;
          const markers = [...found].sort((a, b) => a.range.start.line - b.range.start.line);
          this.partial.set(key, { version, markers });
          for (const e of editorsFor(doc)) this.render(e, markers);
          this.inlayChanged.fire();
        }, 150);
      };
      const analyzer = new Analyzer(
        cts.token,
        this.config().get<number>('maxConcurrentRequests', 4),
        this.config().get<boolean>('showOnTypes', true),
        this.cache,
        { focusLine: this.focusLine(doc), onPartial },
      );
      const markers = await analyzer.analyze(doc);
      if (cts.token.isCancellationRequested || doc.version !== version) return;
      this.retries.delete(key);
      this.partial.delete(key);
      this.state.set(key, { version, markers, ms: Date.now() - started });
      for (const e of editorsFor(doc)) this.render(e, markers);
      this.inlayChanged.fire();
      this.output.appendLine(`${vscode.workspace.asRelativePath(doc.uri)}: ${markers.length} markers in ${Date.now() - started} ms`);
    } catch (err) {
      if (cts.token.isCancellationRequested) return;
      // Language server still starting / indexing → retry with back-off
      const n = (this.retries.get(key) ?? 0) + 1;
      this.retries.set(key, n);
      if (n <= 20) {
        const delay = Math.min(30000, 1500 * n);
        if (!(err instanceof EmptySymbolsError)) this.output.appendLine(`${doc.uri.toString()}: ${String(err)} – retry in ${delay} ms`);
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => void this.compute(doc), delay));
      }
    } finally {
      clearTimeout(partialTimer);
      if (this.pending.get(key) === cts) this.pending.delete(key);
      if (this.computing.get(key) === version) this.computing.delete(key);
      cts.dispose();
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.hoverType, []);
  }

  /** Attach the hover popup (with navigation links) to each member name. */
  private render(editor: vscode.TextEditor, markers: Marker[]): void {
    editor.setDecorations(
      this.hoverType,
      markers.map(m => ({ range: m.range, hoverMessage: hoverFor(m) })),
    );
  }

  // ------------------------------------------------------------ clickable inlay ("1 implementation")

  private inlayHints(doc: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (!this.isRelevant(doc) || !this.config().get<boolean>('inlayHints', true)) return [];
    const markers = this.current(doc);
    if (!markers) return [];
    const hints: vscode.InlayHint[] = [];
    for (const m of markers) {
      const line = m.range.start.line;
      if (line < range.start.line || line > range.end.line) continue;
      const parts: vscode.InlayHintLabelPart[] = [];
      for (const dir of ['up', 'down'] as const) {
        const nav = m[dir];
        if (!nav) continue;
        if (parts.length) parts.push(new vscode.InlayHintLabelPart('  '));
        const part = new vscode.InlayHintLabelPart(inlayLabel(m, dir));
        const title = titleFor(m, dir);
        part.tooltip = `${title} ${nav.targets.map(t => t.label).join(', ')} — click to navigate`;
        part.command = { title, command: PICK_CMD, arguments: [{ title, targets: nav.targets }] };
        parts.push(part);
      }
      const text = doc.lineAt(line).text;
      const end = new vscode.Position(line, text.trimEnd().length);
      const hint = new vscode.InlayHint(end, parts);
      hint.paddingLeft = true;
      hints.push(hint);
    }
    return hints;
  }

  /** Optional CodeLens above the declaration – the only variant VS Code lets you trigger with a plain click. */
  private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isRelevant(doc) || !this.config().get<boolean>('codeLens', false)) return [];
    const markers = this.current(doc);
    if (!markers) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const m of markers) {
      for (const dir of ['up', 'down'] as const) {
        const nav = m[dir];
        if (!nav) continue;
        const title = titleFor(m, dir);
        lenses.push(
          new vscode.CodeLens(m.range, {
            title: inlayLabel(m, dir),
            tooltip: `${title} ${nav.targets.map(t => t.label).join(', ')}`,
            command: PICK_CMD,
            arguments: [{ title, targets: nav.targets }],
          }),
        );
      }
    }
    return lenses;
  }

  // ------------------------------------------------------------ click on the line number

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse || e.selections.length !== 1) return;
    const doc = e.textEditor.document;
    const sel = e.selections[0];
    const fullLine =
      !sel.isEmpty &&
      sel.start.character === 0 &&
      ((sel.end.line === sel.start.line + 1 && sel.end.character === 0) ||
        (sel.end.line === sel.start.line && sel.end.character === doc.lineAt(sel.start.line).text.length));
    const prev = this.lastMouseSel;
    const now = Date.now();
    this.lastMouseSel = { uri: doc.uri.toString(), line: sel.start.line, time: now, fullLine };
    if (!fullLine || !this.config().get<boolean>('clickLineNumber', false)) return;
    // Triple-click in the text also selects the whole line, but is preceded by clicks on the same line.
    if (prev && prev.uri === doc.uri.toString() && prev.line === sel.start.line && !prev.fullLine && now - prev.time < 700) return;
    const m = this.current(doc)?.find(x => x.range.start.line === sel.start.line);
    if (!m) return;
    const editor = e.textEditor;
    // Wait a moment: if the user is dragging over line numbers to select several lines, don't navigate.
    setTimeout(() => {
      const cur = editor.selection;
      if (!cur.isEqual(sel)) return;
      editor.selection = new vscode.Selection(sel.start, sel.start);
      void navigateMarker(m);
    }, 250);
  }

  /** IntelliJ's Ctrl+Alt+B / Ctrl+U equivalents, driven by the computed markers. */
  private async navigateFromCursor(dir: 'up' | 'down'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const line = editor.selection.active.line;
    const markers = this.current(editor.document) ?? [];
    const m = markers.find(x => x.range.start.line === line);
    const nav = m?.[dir];
    if (nav && m) {
      await pickTarget(titleFor(m, dir), nav.targets);
      return;
    }
    if (dir === 'down') await vscode.commands.executeCommand('editor.action.goToImplementation');
    else vscode.window.setStatusBarMessage('No super method / interface found on this line', 3000);
  }
}

// ---------------------------------------------------------------- hover & navigation

function inlayLabel(m: Marker, dir: 'up' | 'down'): string {
  const nav = m[dir]!;
  const n = nav.targets.length;
  if (dir === 'up') return `↑ ${nav.targets[0].label}${n > 1 ? ` +${n - 1}` : ''}`;
  const plural = (w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (nav.kind === 'I') return plural('implementation');
  return m.member === 'type' ? plural('inheritor') : plural('override');
}

/** Navigate from a marker: one direction → jump/picker; both directions → one picker with two sections. */
async function navigateMarker(m: Marker): Promise<void> {
  if (!(m.up && m.down)) {
    const dir = m.up ? 'up' : 'down';
    return pickTarget(titleFor(m, dir), m[dir]!.targets);
  }
  type Item = vscode.QuickPickItem & { target?: Target };
  const items: Item[] = [];
  for (const dir of ['up', 'down'] as const) {
    items.push({ label: `${dir === 'up' ? '↑' : '↓'} ${titleFor(m, dir)}`, kind: vscode.QuickPickItemKind.Separator });
    for (const t of m[dir]!.targets) items.push({ label: `$(symbol-class) ${t.label}`, description: t.detail ? `${t.detail}()` : undefined, detail: describe(t), target: t });
  }
  const picked = await vscode.window.showQuickPick(items, { title: m.name, matchOnDetail: true });
  if (picked?.target) await openTarget(picked.target);
}

function hoverFor(m: Marker): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [OPEN_CMD, PICK_CMD] };
  md.supportThemeIcons = true;
  if (m.up) {
    md.appendMarkdown(`$(arrow-up) **${titleFor(m, 'up')}** `);
    md.appendMarkdown(links(m.up.targets, titleFor(m, 'up')));
    md.appendMarkdown('\n\n');
  }
  if (m.down) {
    md.appendMarkdown(`$(arrow-down) **${titleFor(m, 'down')}** `);
    md.appendMarkdown(links(m.down.targets, titleFor(m, 'down')));
    md.appendMarkdown('\n\n');
  }
  return md;
}

function titleFor(m: Marker, dir: 'up' | 'down'): string {
  const nav = m[dir]!;
  if (m.member === 'type') return nav.kind === 'I' ? 'Is implemented by' : 'Is subclassed by';
  if (dir === 'up') return nav.kind === 'I' ? 'Implements method in' : 'Overrides method in';
  return nav.kind === 'I' ? 'Is implemented in' : 'Is overridden in';
}

function links(targets: Target[], title: string): string {
  const shown = targets.slice(0, MAX_HOVER_LINKS).map(t => `[\`${t.label.replace(/`/g, '')}\`](${cmdUri(OPEN_CMD, t)} "${describe(t).replace(/"/g, "'")}")`);
  let s = shown.join(', ');
  if (targets.length > MAX_HOVER_LINKS) {
    s += `, [and ${targets.length - MAX_HOVER_LINKS} more…](${cmdUri(PICK_CMD, { title, targets })})`;
  }
  if (targets.length > 1) s += ` &nbsp;[$(list-selection) choose…](${cmdUri(PICK_CMD, { title, targets })})`;
  return s;
}

function cmdUri(cmd: string, arg: unknown): string {
  return `command:${cmd}?${encodeURIComponent(JSON.stringify([arg]))}`;
}

function describe(t: Target): string {
  const uri = vscode.Uri.parse(t.uri);
  return `${vscode.workspace.asRelativePath(uri)}:${t.line + 1}`;
}

async function openTarget(t: Target): Promise<void> {
  const pos = new vscode.Position(t.line, t.character);
  await vscode.window.showTextDocument(vscode.Uri.parse(t.uri), { selection: new vscode.Range(pos, pos), preview: true });
}

/** IntelliJ-like "Choose Implementation of …" popup. Jumps directly when there is only one target. */
async function pickTarget(title: string, targets: Target[]): Promise<void> {
  if (targets.length === 0) return;
  if (targets.length === 1) return openTarget(targets[0]);
  const items = targets.map(t => ({
    label: `$(symbol-class) ${t.label}`,
    description: t.detail ? `${t.detail}()` : undefined,
    detail: describe(t),
    target: t,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `${title} (${targets.length} found)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked) await openTarget(picked.target);
}

function editorsFor(doc: vscode.TextDocument): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter(e => e.document === doc);
}
