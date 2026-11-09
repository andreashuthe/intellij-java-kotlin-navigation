import * as vscode from 'vscode';
import { Analyzer, EmptySymbolsError, Marker, Member, MethodHierarchy, Target } from './analyzer';
import { WorkspaceCache } from './cache';
import { MethodHierarchyView } from './hierarchy';
import { createTest, goToTest, jumpToMember } from './testnav';
import { findUsages, UsageTracker } from './usages';
import { mapPositionAll, TextChange, usageLabel } from './util';

interface DocState {
  version: number;
  markers: Marker[];
  /** false = positions were carried along through edits; a fresh analysis is due */
  exact: boolean;
  /** Duration of the analysis in ms (diagnostics) */
  ms?: number;
}

interface MembersState {
  version: number;
  exact: boolean;
  members: Member[];
}

/** CodeLens for a usage count; the count is fetched lazily when VS Code resolves visible lenses. */
class UsageLens extends vscode.CodeLens {
  constructor(
    readonly doc: vscode.TextDocument,
    readonly member: Member,
  ) {
    super(member.range);
  }
}

const OPEN_CMD = 'intellijNav.open';
const PICK_CMD = 'intellijNav.pick';
const USAGES_CMD = 'intellijNav.showUsages';
const MAX_HOVER_LINKS = 6;

/** Public API (used by the integration tests; handy for other extensions too). */
export interface IntellijNavApi {
  markers(uri: vscode.Uri): Marker[] | undefined;
  /** Markers together with the document version they were computed for. */
  markersInfo(uri: vscode.Uri): { version: number; markers: Marker[]; ms?: number } | undefined;
  /** Usage counts computed so far, by member key (tests / diagnostics). */
  usagesInfo(uri: vscode.Uri): { counts: Record<string, number | undefined>; requests: number };
  /** Hierarchy last shown in the Method Hierarchy view. */
  methodHierarchy(): MethodHierarchy | undefined;
}

export function activate(context: vscode.ExtensionContext): IntellijNavApi {
  const controller = new Controller();
  context.subscriptions.push(controller);
  return {
    markers: uri => controller.markersFor(uri),
    markersInfo: uri => controller.markersInfo(uri),
    usagesInfo: uri => controller.usagesInfo(uri),
    methodHierarchy: () => controller.hierarchy.current,
  };
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

/** Settings, read once and refreshed on configuration changes (not on every keystroke). */
interface Settings {
  enabled: boolean;
  languages: string[];
  inlayHints: boolean;
  usages: boolean;
  codeLens: boolean;
  clickLineNumber: boolean;
  showOnTypes: boolean;
  refreshDelay: number;
  maxConcurrentRequests: number;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('intellijNav');
  return {
    enabled: c.get<boolean>('enabled', true),
    languages: c.get<string[]>('languages', ['java', 'kotlin']),
    inlayHints: c.get<boolean>('inlayHints', true),
    usages: c.get<boolean>('usages', true),
    codeLens: c.get<boolean>('codeLens', false),
    clickLineNumber: c.get<boolean>('clickLineNumber', false),
    showOnTypes: c.get<boolean>('showOnTypes', true),
    refreshDelay: c.get<number>('refreshDelay', 1000),
    maxConcurrentRequests: c.get<number>('maxConcurrentRequests', 4),
  };
}

class Controller implements vscode.Disposable {
  private cfg: Settings = readSettings();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly state = new Map<string, DocState>();
  /** Markers found so far by a running analysis (rendered progressively). */
  private readonly partial = new Map<string, DocState>();
  private readonly pending = new Map<string, vscode.CancellationTokenSource>();
  /** Document version each running analysis works on (avoids starting the same analysis twice). */
  private readonly computing = new Map<string, number>();
  private readonly cache = new WorkspaceCache();
  private readonly members = new Map<string, MembersState>();
  readonly hierarchy = new MethodHierarchyView((doc, pos) =>
    this.hierarchyAnalysis(doc, pos),
  );
  /** Running Method Hierarchy computation (cancelled when a new one is requested). */
  private hierarchyCts?: vscode.CancellationTokenSource;
  private readonly usages = new UsageTracker(() => this.cfg.refreshDelay);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly retries = new Map<string, number>();
  private readonly output = vscode.window.createOutputChannel('IntelliJ Java/Kotlin Navigation');
  private readonly inlayChanged = new vscode.EventEmitter<void>();
  /** Last mouse selection, used to tell a line-number click apart from a triple-click in the text. */
  private lastMouseSel?: { uri: string; line: number; time: number; fullLine: boolean };

  constructor() {
    this.disposables.push(
      this.output,
      // hover popup on member names, built only when the user actually hovers
      vscode.languages.registerHoverProvider([{ language: 'java' }, { language: 'kotlin' }], {
        provideHover: (doc, pos) => {
          if (!this.isRelevant(doc)) return undefined;
          const m = this.current(doc)?.find(x => x.range.contains(pos));
          return m ? new vscode.Hover(hoverFor(m), m.range) : undefined;
        },
      }),
      vscode.commands.registerCommand(OPEN_CMD, (t: Target) => openTarget(t)),
      vscode.commands.registerCommand(PICK_CMD, (arg: { title: string; targets: Target[] }) => pickTarget(arg.title, arg.targets)),
      vscode.commands.registerCommand(USAGES_CMD, (arg?: { uri: string; line: number; character: number }) => showUsages(arg)),
      vscode.commands.registerCommand('intellijNav.goToTest', (uri?: vscode.Uri) => goToTest(uri instanceof vscode.Uri ? uri : undefined)),
      vscode.commands.registerCommand('intellijNav.createTest', (uri?: vscode.Uri) => createTest(uri instanceof vscode.Uri ? uri : undefined)),
      this.hierarchy,
      vscode.commands.registerCommand('intellijNav.showMethodHierarchy', (uri?: vscode.Uri, pos?: vscode.Position) =>
        this.hierarchy.show(uri instanceof vscode.Uri ? uri : undefined, pos instanceof vscode.Position ? pos : undefined),
      ),
      vscode.commands.registerCommand('intellijNav.refreshMethodHierarchy', () => this.hierarchy.refresh()),
      vscode.commands.registerCommand('intellijNav.nextMember', () => jumpToMember(1)),
      vscode.commands.registerCommand('intellijNav.previousMember', () => jumpToMember(-1)),
      this.usages,
      this.usages.onDidChange(() => this.inlayChanged.fire()),
      vscode.commands.registerCommand('intellijNav.goToImplementations', () => this.navigateFromCursor('down')),
      vscode.commands.registerCommand('intellijNav.goToSuper', () => this.navigateFromCursor('up')),
      vscode.commands.registerCommand('intellijNav.refresh', () => {
        this.cache.clear();
        this.usages.clear();
        this.refreshAll(true);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll(false)),
      vscode.window.onDidChangeActiveTextEditor(e => e && this.schedule(e.document, 0)),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (!this.isRelevant(e.document) || !e.contentChanges.length) return;
        const key = e.document.uri.toString();
        // keep the hints next to their declarations until the next analysis
        this.carryAlong(e);
        this.usages.documentChanged(e.document.uri);
        // results of other files may depend on this one; stop work on the outdated version right away
        this.cache.documentChanged(e.document.uri);
        this.pending.get(key)?.cancel();
        // only files on screen are analysed; others (e.g. touched by a refactoring) when they are shown
        if (editorsFor(e.document).length) this.schedule(e.document, this.cfg.refreshDelay);
      }),
      // A save anywhere can change the hierarchy of the files on screen → recompute visible editors
      vscode.workspace.onDidSaveTextDocument(d => {
        if (this.isRelevant(d)) {
          this.usages.invalidateAll();
          // debounced: with auto-save this fires every second while typing
          this.refreshAll(true, this.cfg.refreshDelay);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(d => this.forget(d.uri.toString())),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('intellijNav')) {
          this.cfg = readSettings();
          this.cache.clear();
          this.usages.clear();
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
        {
          onDidChangeCodeLenses: this.inlayChanged.event,
          provideCodeLenses: doc => this.codeLenses(doc),
          resolveCodeLens: lens => this.resolveCodeLens(lens),
        },
      ),
      vscode.window.onDidChangeTextEditorSelection(e => this.onSelection(e)),
    );
    // Files changed outside the editor (git checkout, build, other tools)
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{java,kt,kts}');
    const external = (uri: vscode.Uri) => {
      this.cache.documentChanged(uri);
      this.usages.invalidateAll();
    };
    this.disposables.push(watcher, watcher.onDidCreate(external), watcher.onDidChange(external), watcher.onDidDelete(external));
    this.refreshAll(false);
  }

  private hierarchyAnalysis(doc: vscode.TextDocument, pos: vscode.Position): Promise<MethodHierarchy | undefined> {
    this.hierarchyCts?.cancel();
    this.hierarchyCts?.dispose();
    const cts = (this.hierarchyCts = new vscode.CancellationTokenSource());
    return new Analyzer(cts.token, this.cfg.maxConcurrentRequests, true, this.cache)
      .methodHierarchy(doc, pos)
      .then(r => (cts.token.isCancellationRequested ? undefined : r));
  }

  markersFor(uri: vscode.Uri): Marker[] | undefined {
    return this.state.get(uri.toString())?.markers;
  }

  markersInfo(uri: vscode.Uri): { version: number; markers: Marker[]; ms?: number } | undefined {
    const st = this.state.get(uri.toString());
    return st?.exact ? { version: st.version, markers: st.markers, ms: st.ms } : undefined;
  }

  usagesInfo(uri: vscode.Uri): { counts: Record<string, number | undefined>; requests: number } {
    const counts: Record<string, number | undefined> = {};
    for (const m of this.members.get(uri.toString())?.members ?? []) counts[m.key] = this.usages.get(uri, m.key)?.count;
    return { counts, requests: this.usages.requests };
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const c of this.pending.values()) c.cancel();
    this.hierarchyCts?.cancel();
    for (const d of this.disposables) d.dispose();
  }

  private isRelevant(doc: vscode.TextDocument): boolean {
    if (!this.cfg.enabled) return false;
    if (doc.uri.scheme === 'output' || doc.uri.scheme === 'git') return false;
    return this.cfg.languages.includes(doc.languageId);
  }

  private refreshAll(force: boolean, delay = 0): void {
    // keep showing the old results while the new analysis runs
    if (force) for (const st of this.state.values()) st.exact = false;
    for (const e of vscode.window.visibleTextEditors) {
      if (this.isRelevant(e.document)) this.schedule(e.document, delay);
    }
  }

  private forget(key: string): void {
    this.state.delete(key);
    this.partial.delete(key);
    this.members.delete(key);
    this.usages.forget(vscode.Uri.parse(key));
    this.pending.get(key)?.cancel();
    this.pending.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.retries.delete(key);
  }

  private schedule(doc: vscode.TextDocument, delay: number): void {
    if (!this.isRelevant(doc)) return;
    const key = doc.uri.toString();
    const cached = this.state.get(key);
    if (cached && cached.exact && cached.version === doc.version) return; // up to date
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

  /** Countable members for the current version (exact or carried along through edits). */
  private currentMembers(doc: vscode.TextDocument): MembersState | undefined {
    const ms = this.members.get(doc.uri.toString());
    return ms && ms.version === doc.version ? ms : undefined;
  }

  /** Move stored results along with an edit instead of hiding them until the next analysis. */
  private carryAlong(e: vscode.TextDocumentChangeEvent): void {
    const key = e.document.uri.toString();
    const version = e.document.version;
    const changes: TextChange[] = e.contentChanges.map(c => ({ start: c.range.start, end: c.range.end, text: c.text }));
    const mapRange = (r: vscode.Range): vscode.Range | undefined => {
      const s = mapPositionAll(r.start, changes);
      const en = mapPositionAll(r.end, changes);
      return s && en ? new vscode.Range(s.line, s.character, en.line, en.character) : undefined;
    };
    const mapTarget = (t: Target): Target => {
      if (t.uri !== key) return t;
      const p = mapPositionAll({ line: t.line, character: t.character }, changes);
      return p ? { ...t, line: p.line, character: p.character } : t;
    };
    for (const map of [this.state, this.partial]) {
      const st = map.get(key);
      if (!st || st.version === version) continue;
      const markers: Marker[] = [];
      for (const m of st.markers) {
        const range = mapRange(m.range);
        if (!range) continue;
        markers.push({
          ...m,
          range,
          up: m.up && { ...m.up, targets: m.up.targets.map(mapTarget) },
          down: m.down && { ...m.down, targets: m.down.targets.map(mapTarget) },
        });
      }
      map.set(key, { ...st, version, markers, exact: false });
    }
    const ms = this.members.get(key);
    if (ms && ms.version !== version) {
      const members: Member[] = [];
      for (const m of ms.members) {
        const range = mapRange(m.range);
        if (range) members.push({ ...m, range });
      }
      this.members.set(key, { version, exact: false, members });
    }
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
          this.partial.set(key, { version, markers, exact: true });
          this.inlayChanged.fire();
        }, 150);
      };
      const analyzer = new Analyzer(
        cts.token,
        this.cfg.maxConcurrentRequests,
        this.cfg.showOnTypes,
        this.cache,
        {
          focusLine: this.focusLine(doc),
          onPartial,
          onMembers: members => {
            if (cts.token.isCancellationRequested || doc.version !== version) return;
            this.members.set(key, { version, exact: true, members });
            this.inlayChanged.fire();
          },
        },
      );
      const markers = await analyzer.analyze(doc);
      if (cts.token.isCancellationRequested || doc.version !== version) return;
      this.retries.delete(key);
      this.partial.delete(key);
      this.state.set(key, { version, markers, exact: true, ms: Date.now() - started });
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

  // ------------------------------------------------------------ clickable inlay ("1 implementation")

  private inlayHints(doc: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (!this.isRelevant(doc) || !this.cfg.inlayHints) return [];
    const inRange = (line: number) => line >= range.start.line && line <= range.end.line;
    const byLine = new Map<number, { marker?: Marker; member?: Member }>();
    for (const m of this.current(doc) ?? []) {
      if (inRange(m.range.start.line)) byLine.set(m.range.start.line, { marker: m });
    }
    const showUsages = this.cfg.usages;
    const ms = showUsages ? this.currentMembers(doc) : undefined;
    const visibleMembers: Member[] = [];
    for (const m of ms?.members ?? []) {
      const line = m.range.start.line;
      if (!inRange(line)) continue;
      visibleMembers.push(m);
      const slot = byLine.get(line) ?? {};
      slot.member ??= m;
      byLine.set(line, slot);
    }
    // count usages of what is on screen (lazily, in the background)
    if (ms?.exact && visibleMembers.length) this.usages.ensure(doc, visibleMembers);

    const hints: vscode.InlayHint[] = [];
    for (const [line, { marker, member }] of [...byLine].sort((a, b) => a[0] - b[0])) {
      const parts: vscode.InlayHintLabelPart[] = [];
      const count = member && this.usages.get(doc.uri, member.key)?.count;
      if (member && count !== undefined) {
        const part = new vscode.InlayHintLabelPart(usageLabel(count));
        part.tooltip = count ? `Show usages of ${member.name}` : `${member.name} is not used`;
        if (count) {
          const p = member.range.start;
          part.command = { title: 'Show usages', command: USAGES_CMD, arguments: [{ uri: doc.uri.toString(), line: p.line, character: p.character }] };
        }
        parts.push(part);
      }
      for (const dir of ['up', 'down'] as const) {
        const nav = marker?.[dir];
        if (!marker || !nav) continue;
        if (parts.length) parts.push(new vscode.InlayHintLabelPart('  '));
        const part = new vscode.InlayHintLabelPart(inlayLabel(marker, dir));
        const title = titleFor(marker, dir);
        part.tooltip = `${title} ${nav.targets.map(t => t.label).join(', ')} — click to navigate`;
        part.command = { title, command: PICK_CMD, arguments: [{ title, targets: nav.targets }] };
        parts.push(part);
      }
      if (!parts.length || line >= doc.lineCount) continue;
      const text = doc.lineAt(line).text;
      const hint = new vscode.InlayHint(new vscode.Position(line, text.trimEnd().length), parts);
      hint.paddingLeft = true;
      hints.push(hint);
    }
    return hints;
  }

  /** Optional CodeLens above the declaration – the only variant VS Code lets you trigger with a plain click. */
  private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isRelevant(doc) || !this.cfg.codeLens) return [];
    const lenses: vscode.CodeLens[] = [];
    if (this.cfg.usages) {
      const ms = this.currentMembers(doc);
      if (ms?.exact) for (const m of ms.members) lenses.push(new UsageLens(doc, m));
    }
    for (const m of this.current(doc) ?? []) {
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

  private async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    if (!(lens instanceof UsageLens) || lens.command) return lens;
    const count = (await this.usages.countNow(lens.doc, lens.member)) ?? 0;
    const p = lens.member.range.start;
    lens.command = count
      ? { title: usageLabel(count), command: USAGES_CMD, arguments: [{ uri: lens.doc.uri.toString(), line: p.line, character: p.character }] }
      : { title: usageLabel(0), command: '' };
    return lens;
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
    if (!fullLine || !this.cfg.clickLineNumber) return;
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

/**
 * IntelliJ's "Show Usages": one usage → jump there, several → VS Code's references peek.
 * Without argument it works on the symbol under the cursor.
 */
async function showUsages(arg?: { uri: string; line: number; character: number }): Promise<void> {
  let uri: vscode.Uri;
  let pos: vscode.Position;
  if (arg) {
    uri = vscode.Uri.parse(arg.uri);
    pos = new vscode.Position(arg.line, arg.character);
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    uri = editor.document.uri;
    pos = editor.document.getWordRangeAtPosition(editor.selection.active)?.start ?? editor.selection.active;
  }
  const usages = await findUsages(uri, pos);
  if (usages.length === 0) {
    vscode.window.setStatusBarMessage('No usages found', 3000);
    return;
  }
  if (usages.length === 1) {
    await vscode.window.showTextDocument(usages[0].uri, { selection: usages[0].range, preview: true });
    return;
  }
  // make sure the declaring file is the active editor (the peek view opens there)
  if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) {
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preview: true });
  }
  await vscode.commands.executeCommand('editor.action.showReferences', uri, pos, usages);
}

function editorsFor(doc: vscode.TextDocument): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter(e => e.document === doc);
}
