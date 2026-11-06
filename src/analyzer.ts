import * as vscode from 'vscode';
import { WorkspaceCache } from './cache';
import { createLimiter, hasBodyAfterName } from './util';
import {
  bareName,
  findMatchingMethod,
  MethodSig,
  parseParameterTypes,
  parseSupertypeRefs,
  typesFromSymbolName,
} from './signature';

/** A navigation target, kept JSON-serializable so it can travel through command links. */
export interface Target {
  uri: string;
  line: number;
  character: number;
  /** Type name, e.g. `EntityRepositoryDao` */
  label: string;
  /** Optional member name / location hint */
  detail?: string;
}

export type MarkerKind = 'I' | 'O';

export interface Marker {
  /** Range of the declaration name — icon goes on this line, hover attaches here. */
  range: vscode.Range;
  name: string;
  member: 'type' | 'method';
  /** Navigation towards supertypes (implements / overrides) */
  up?: { kind: MarkerKind; targets: Target[] };
  /** Navigation towards subtypes (implemented by / overridden by / subclassed by) */
  down?: { kind: MarkerKind; targets: Target[] };
}

const TYPE_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Object,
]);
const METHOD_KINDS = new Set<vscode.SymbolKind>([vscode.SymbolKind.Method, vscode.SymbolKind.Function]);

interface ResolvedType {
  uri: vscode.Uri;
  symbol: vscode.DocumentSymbol;
  name: string;
  isInterface: boolean;
}

interface MethodInfo extends MethodSig {
  symbol: vscode.DocumentSymbol;
  isAbstract: boolean;
}

export class EmptySymbolsError extends Error {}

export interface AnalyzeOptions {
  /** Line the user is looking at: members closest to it are analysed first. */
  focusLine?: number;
  /** Called (repeatedly) with the markers found so far, for progressive rendering. */
  onPartial?: (markers: Marker[]) => void;
}

/**
 * Computes inheritance markers for one document, using only standard VS Code
 * provider commands. Every request is answered by whatever language server
 * is active (JetBrains' IntelliJ server, Red Hat Java, Kotlin LSP, ...).
 */
export class Analyzer {
  /** Symbols of the analysed document itself (always fresh). */
  private ownSymbols?: Promise<vscode.DocumentSymbol[]>;
  private docCache = new Map<string, Promise<vscode.TextDocument | undefined>>();
  private ancestorCache = new Map<string, Promise<ResolvedType[]>>();
  /** Method lists of supertypes, computed once per analysis instead of once per overriding method. */
  private candidateCache = new Map<string, MethodInfo[]>();
  /** Full text per document version – `doc.getText()` copies the whole file on every call. */
  private textCache = new Map<string, { version: number; text: string }>();
  private readonly limit: <T>(fn: () => Thenable<T> | Promise<T>) => Promise<T>;
  private uri!: vscode.Uri;

  constructor(
    private readonly token: vscode.CancellationToken,
    maxConcurrent: number,
    private readonly showOnTypes: boolean,
    private readonly cache: WorkspaceCache = new WorkspaceCache(),
    private readonly options: AnalyzeOptions = {},
  ) {
    this.limit = createLimiter(maxConcurrent, token);
  }

  async analyze(doc: vscode.TextDocument): Promise<Marker[]> {
    this.uri = doc.uri;
    const symbols = await this.symbols(doc.uri, true);
    if (symbols.length === 0) {
      if (/\b(class|interface|enum|record|object)\b/.test(this.text(doc))) throw new EmptySymbolsError('language server not ready');
      return [];
    }
    this.docCache.set(doc.uri.toString(), Promise.resolve(doc));
    const markers: Marker[] = [];
    const types: vscode.DocumentSymbol[] = [];
    const visitTypes = (list: vscode.DocumentSymbol[]) => {
      for (const s of list) {
        if (TYPE_KINDS.has(s.kind)) types.push(s);
        if (s.children?.length) visitTypes(s.children);
      }
    };
    visitTypes(symbols);
    // Language-server requests run in the order they are queued: start with what is on screen.
    const focus = this.options.focusLine;
    if (focus !== undefined) types.sort((a, b) => distance(a.range, focus) - distance(b.range, focus));
    const multiType = types.length > 1;
    const onFound = (m: Marker) => {
      markers.push(m);
      this.options.onPartial?.(markers);
    };
    await Promise.all(types.map(t => this.analyzeType(doc, t, onFound, multiType)));
    markers.sort((a, b) => a.range.start.line - b.range.start.line);
    return markers;
  }

  private text(doc: vscode.TextDocument): string {
    const key = doc.uri.toString();
    const hit = this.textCache.get(key);
    if (hit && hit.version === doc.version) return hit.text;
    const text = doc.getText();
    this.textCache.set(key, { version: doc.version, text });
    return text;
  }

  // ---------------------------------------------------------------- types

  private async analyzeType(doc: vscode.TextDocument, type: vscode.DocumentSymbol, out: (m: Marker) => void, multiType: boolean): Promise<void> {
    const isInterface = this.isInterface(doc, type);
    const header = this.headerText(doc, type);
    const kotlin = doc.languageId === 'kotlin';
    // Kotlin classes are final unless declared open/abstract/sealed; Kotlin `object`s can't be subclassed at all.
    const isFinalType = isInterface
      ? false
      : kotlin
        ? !/\b(open|abstract|sealed)\b/.test(header) || type.kind === vscode.SymbolKind.Object
        : /\b(final|record|enum)\b/.test(header);
    const typeName = bareName(type.name);
    // Entries pointing into this file must be dropped when it is edited if it holds several types
    const selfRefDefault = multiType;

    const ancestorsP = this.ancestors(doc.uri, type, doc);

    // Type-level: "is implemented by" / "is subclassed by" (IntelliJ shows only the ↓ icon on types)
    // All subtypes (one request per type). Methods of a type without subtypes can't be overridden,
    // so this single answer saves one request per method for every "leaf" class.
    const subtypesP: Promise<Target[]> = isFinalType
      ? Promise.resolve([])
      : this.implementations(doc.uri, type.selectionRange.start, type.selectionRange, `T:${typeName}`, selfRefDefault);
    let resolvedSubsP: Promise<ResolvedType[] | undefined> | undefined;
    const resolvedSubtypes = () =>
      (resolvedSubsP ??= subtypesP.then(async subs => {
        const resolved = await Promise.all(subs.map(t => this.resolveTypeAt(vscode.Uri.parse(t.uri), new vscode.Position(t.line, t.character))));
        // a subtype we can't look into (e.g. library) → fall back to asking per method
        return resolved.every(r => r) ? (resolved as ResolvedType[]) : undefined;
      }));

    const typeJob = (async () => {
      if (!this.showOnTypes || isFinalType) return;
      const impls = await subtypesP;
      if (impls.length) {
        out({
          range: type.selectionRange,
          name: bareName(type.name),
          member: 'type',
          down: { kind: isInterface ? 'I' : 'O', targets: impls },
        });
      }
    })();

    const methods = (type.children ?? []).filter(c => METHOD_KINDS.has(c.kind));
    const focus = this.options.focusLine;
    if (focus !== undefined) methods.sort((a, b) => distance(a.range, focus) - distance(b.range, focus));
    const seenKeys = new Map<string, number>();
    const methodJobs = methods.map(async m => {
      const modifiers = this.modifierText(doc, m);
      if (/\b(static|private)\b/.test(modifiers)) return;
      const sig = this.methodSig(doc, m);
      const isAbstract = isInterface
        ? kotlin
          ? !this.hasBody(doc, m)
          : !/\bdefault\b/.test(modifiers)
        : /\babstract\b/.test(modifiers);
      // Kotlin members are final unless open/abstract/override (and not `final override`)
      const canBeOverridden = !kotlin || isInterface || /\b(open|abstract)\b/.test(modifiers) || (/\boverride\b/.test(modifiers) && !/\bfinal\b/.test(modifiers));
      let memberKey = `M:${typeName}.${sig.name}(${sig.params?.join(',') ?? '?'})`;
      const dup = seenKeys.get(memberKey) ?? 0;
      seenKeys.set(memberKey, dup + 1);
      if (dup) memberKey += `#${dup}`;

      const marker: Marker = { range: m.selectionRange, name: sig.name, member: 'method' };

      // ↑ implements / overrides
      const upJob = (async () => {
        const ancestors = await ancestorsP;
        const targets: Target[] = [];
        let kind: MarkerKind = 'O';
        for (const anc of ancestors) {
          const candidates = await this.candidates(anc);
          const match = findMatchingMethod(sig, candidates);
          if (match) {
            if (targets.length === 0) kind = anc.isInterface || match.isAbstract ? 'I' : 'O';
            targets.push({
              uri: anc.uri.toString(),
              line: match.symbol.selectionRange.start.line,
              character: match.symbol.selectionRange.start.character,
              label: anc.name,
              detail: match.name,
            });
          }
        }
        if (targets.length) marker.up = { kind, targets };
      })();

      // ↓ implemented / overridden in
      const downJob = (async () => {
        if (isFinalType || !canBeOverridden || /\bfinal\b/.test(modifiers)) return;
        if ((await subtypesP).length === 0) return; // nothing can override it
        const subs = await resolvedSubtypes();
        let impls: Target[];
        if (subs) {
          // match the method in each subtype by signature – no language-server request needed
          impls = [];
          for (const sub of subs) {
            const match = findMatchingMethod(sig, await this.candidates(sub));
            if (match) {
              impls.push({
                uri: sub.uri.toString(),
                line: match.symbol.selectionRange.start.line,
                character: match.symbol.selectionRange.start.character,
                label: sub.name,
                detail: match.name,
              });
            }
          }
          impls.sort((a, b) => a.label.localeCompare(b.label));
          // An abstract/interface method with subtypes but no matching method found: our signature
          // matching may have missed it (unusual generics, cross-language types) – ask the server.
          if (impls.length === 0 && isAbstract) {
            impls = await this.implementations(doc.uri, m.selectionRange.start, m.selectionRange, memberKey, selfRefDefault);
          }
        } else {
          impls = await this.implementations(doc.uri, m.selectionRange.start, m.selectionRange, memberKey, selfRefDefault);
        }
        if (impls.length) marker.down = { kind: isInterface || isAbstract ? 'I' : 'O', targets: impls };
      })();

      await Promise.all([upJob, downJob]);
      if (marker.up || marker.down) out(marker);
    });

    await Promise.all([typeJob, ...methodJobs]);
  }

  /** Overridable methods of a supertype, parsed once per analysis. */
  private async candidates(anc: ResolvedType): Promise<MethodInfo[]> {
    const key = keyOf(anc.uri, anc.symbol);
    const hit = this.candidateCache.get(key);
    if (hit) return hit;
    const ancDoc = await this.document(anc.uri);
    const list: MethodInfo[] = [];
    if (ancDoc) {
      const kotlin = ancDoc.languageId === 'kotlin';
      for (const c of anc.symbol.children ?? []) {
        if (!METHOD_KINDS.has(c.kind)) continue;
        const mods = this.modifierText(ancDoc, c);
        if (/\b(static|private)\b/.test(mods)) continue;
        const isAbstract = anc.isInterface ? (kotlin ? !this.hasBody(ancDoc, c) : !/\bdefault\b/.test(mods)) : /\babstract\b/.test(mods);
        list.push({ ...this.methodSig(ancDoc, c), symbol: c, isAbstract });
      }
    }
    this.candidateCache.set(key, list);
    return list;
  }

  /** Kotlin interface members are abstract unless they have a body (`{ … }` or `= …`). */
  private hasBody(doc: vscode.TextDocument, m: vscode.DocumentSymbol): boolean {
    const start = doc.offsetAt(m.selectionRange.end);
    const end = Math.max(start, Math.min(doc.offsetAt(m.range.end), start + 4000));
    return hasBodyAfterName(this.text(doc).slice(start, end));
  }

  private isInterface(doc: vscode.TextDocument, type: vscode.DocumentSymbol): boolean {
    if (type.kind === vscode.SymbolKind.Interface) return true;
    return /\binterface\b/.test(this.modifierText(doc, type));
  }

  /** Text between the start of the symbol (annotations/modifiers) and its name. */
  private modifierText(doc: vscode.TextDocument, s: vscode.DocumentSymbol): string {
    const start = s.range.start.isBefore(s.selectionRange.start) ? s.range.start : s.selectionRange.start.with({ character: 0 });
    return stripComments(this.text(doc).slice(doc.offsetAt(start), doc.offsetAt(s.selectionRange.start)));
  }

  /** Text from the type name up to (not including) the opening `{`. */
  private headerText(doc: vscode.TextDocument, type: vscode.DocumentSymbol): string {
    const startOff = doc.offsetAt(type.selectionRange.end);
    const text = this.text(doc).slice(startOff, startOff + 4000);
    const brace = text.indexOf('{');
    return this.modifierText(doc, type) + ' ' + stripComments(brace >= 0 ? text.slice(0, brace) : text.split('\n')[0]);
  }

  private methodSig(doc: vscode.TextDocument, m: vscode.DocumentSymbol): MethodSig {
    const name = bareName(m.name);
    let params = typesFromSymbolName(m.name);
    if (!params) {
      const startOff = doc.offsetAt(m.selectionRange.end);
      const after = this.text(doc).slice(startOff, startOff + 2000);
      if (/^\s*\(/.test(after)) params = parseParameterTypes(after, doc.languageId);
    }
    return { name, params };
  }

  // ---------------------------------------------------------------- supertypes

  /** All ancestors (BFS, nearest first), resolved to source symbols where possible. */
  private ancestors(uri: vscode.Uri, type: vscode.DocumentSymbol, doc: vscode.TextDocument): Promise<ResolvedType[]> {
    const key = `${uri.toString()}#${type.selectionRange.start.line}:${type.selectionRange.start.character}`;
    let p = this.ancestorCache.get(key);
    if (!p) {
      p = this.computeAncestors(uri, type, doc);
      this.ancestorCache.set(key, p);
    }
    return p;
  }

  private async computeAncestors(uri: vscode.Uri, type: vscode.DocumentSymbol, doc: vscode.TextDocument): Promise<ResolvedType[]> {
    const result: ResolvedType[] = [];
    const seen = new Set<string>([keyOf(uri, type)]);
    let frontier: { uri: vscode.Uri; symbol: vscode.DocumentSymbol; doc: vscode.TextDocument }[] = [{ uri, symbol: type, doc }];
    for (let depth = 0; depth < 12 && frontier.length; depth++) {
      const next: typeof frontier = [];
      for (const f of frontier) {
        if (this.token.isCancellationRequested) return result;
        const direct = await this.directSupertypes(f.uri, f.symbol, f.doc);
        for (const d of direct) {
          const k = keyOf(d.uri, d.symbol);
          if (seen.has(k)) continue;
          seen.add(k);
          result.push(d);
          const dDoc = await this.document(d.uri);
          if (dDoc) next.push({ uri: d.uri, symbol: d.symbol, doc: dDoc });
        }
      }
      frontier = next;
    }
    return result;
  }

  private async directSupertypes(uri: vscode.Uri, type: vscode.DocumentSymbol, doc: vscode.TextDocument): Promise<ResolvedType[]> {
    const key = `S:${uri.toString()}#${bareName(type.name)}#${this.headerText(doc, type)}`;
    const hit = this.cache.get<ResolvedType[]>(key);
    if (hit) return hit;
    const result = await this.computeDirectSupertypes(uri, type, doc);
    if (!this.token.isCancellationRequested) {
      const selfRef = result.some(r => r.uri.toString() === uri.toString());
      this.cache.set(key, uri, result, selfRef);
    }
    return result;
  }

  private async computeDirectSupertypes(uri: vscode.Uri, type: vscode.DocumentSymbol, doc: vscode.TextDocument): Promise<ResolvedType[]> {
    // 1) LSP type hierarchy, if the server supports it
    try {
      const items = await this.limit(() =>
        vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', uri, type.selectionRange.start),
      );
      if (items?.length) {
        const supers = await this.limit(() => vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.provideSupertypes', items[0]));
        if (supers) {
          const resolved: ResolvedType[] = [];
          for (const s of supers) {
            if (s.name === 'Object' || s.name === 'java.lang.Object' || s.name === 'Any') continue;
            const r = await this.resolveTypeAt(s.uri, s.selectionRange.start, s.kind === vscode.SymbolKind.Interface);
            if (r) resolved.push(r);
          }
          return resolved;
        }
      }
    } catch {
      /* not supported by this server – fall back */
    }

    // 2) Fallback: parse `extends/implements` and ask "go to definition" for each name
    const startOff = doc.offsetAt(type.selectionRange.end);
    const text = this.text(doc).slice(startOff, startOff + 4000);
    const brace = text.indexOf('{');
    const header = brace >= 0 ? text.slice(0, brace) : text.split('\n')[0];
    const refs = parseSupertypeRefs(blankComments(header), doc.languageId);
    const resolved: ResolvedType[] = [];
    for (const ref of refs) {
      const pos = doc.positionAt(startOff + ref.offset);
      const defs = await this.limit(() =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos),
      );
      const first = defs?.[0];
      if (!first) continue;
      const target = toLocation(first);
      const r = await this.resolveTypeAt(target.uri, target.range.start);
      if (r) resolved.push(r);
    }
    return resolved;
  }

  private async resolveTypeAt(uri: vscode.Uri, pos: vscode.Position, interfaceHint?: boolean): Promise<ResolvedType | undefined> {
    const symbols = await this.symbols(uri);
    let best: vscode.DocumentSymbol | undefined;
    const walk = (list: vscode.DocumentSymbol[]) => {
      for (const s of list) {
        if (TYPE_KINDS.has(s.kind) && (s.range.contains(pos) || s.selectionRange.contains(pos))) {
          best = s;
        }
        if (s.children?.length && s.range.contains(pos)) walk(s.children);
      }
    };
    walk(symbols);
    if (!best) return undefined;
    const d = await this.document(uri);
    const isIface = interfaceHint || (d ? this.isInterface(d, best) : best.kind === vscode.SymbolKind.Interface);
    return { uri, symbol: best, name: bareName(best.name), isInterface: isIface };
  }

  // ---------------------------------------------------------------- implementations

  private async implementations(uri: vscode.Uri, pos: vscode.Position, self: vscode.Range, memberKey: string, selfRefDefault: boolean): Promise<Target[]> {
    const key = `I:${uri.toString()}#${memberKey}`;
    const hit = this.cache.get<Target[]>(key);
    if (hit) return hit;
    const targets = await this.computeImplementations(uri, pos, self);
    if (!this.token.isCancellationRequested) {
      const selfRef = selfRefDefault || targets.some(t => t.uri === uri.toString());
      this.cache.set(key, uri, targets, selfRef);
    }
    return targets;
  }

  private async computeImplementations(uri: vscode.Uri, pos: vscode.Position, self: vscode.Range): Promise<Target[]> {
    if (this.token.isCancellationRequested) return [];
    let locs: (vscode.Location | vscode.LocationLink)[] | undefined;
    try {
      locs = await this.limit(() =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeImplementationProvider', uri, pos),
      );
    } catch {
      return [];
    }
    const targets: Target[] = [];
    const seen = new Set<string>();
    for (const l of locs ?? []) {
      const loc = toLocation(l);
      if (loc.uri.toString() === uri.toString() && loc.range.intersection(self)) continue; // self
      const k = `${loc.uri.toString()}:${loc.range.start.line}`;
      if (seen.has(k)) continue;
      seen.add(k);
      targets.push({
        uri: loc.uri.toString(),
        line: loc.range.start.line,
        character: loc.range.start.character,
        label: '',
      });
    }
    // Label each target with its enclosing type name (what IntelliJ shows in its popup)
    await Promise.all(
      targets.slice(0, 30).map(async t => {
        const u = vscode.Uri.parse(t.uri);
        const pos2 = new vscode.Position(t.line, t.character);
        const syms = await this.symbols(u);
        const chain = enclosingChain(syms, pos2);
        const type = [...chain].reverse().find(s => TYPE_KINDS.has(s.kind));
        t.label = type ? bareName(type.name) : basename(u);
        const self2 = chain[chain.length - 1];
        if (self2 && self2 !== type) t.detail = bareName(self2.name);
      }),
    );
    for (const t of targets) if (!t.label) t.label = basename(vscode.Uri.parse(t.uri));
    targets.sort((a, b) => a.label.localeCompare(b.label));
    return targets;
  }

  // ---------------------------------------------------------------- caches

  private symbols(uri: vscode.Uri, strict = false): Promise<vscode.DocumentSymbol[]> {
    const fetch = () =>
      this.limit(() =>
        vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri),
      ).then(r => normalizeSymbols(r ?? []));
    if (uri.toString() === this.uri?.toString()) {
      this.ownSymbols ??= fetch();
      return strict ? this.ownSymbols : this.ownSymbols.catch(() => []);
    }
    return this.cache.symbolsFor(uri, fetch).catch(err => {
      if (strict) throw err;
      return [];
    });
  }

  private document(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const key = uri.toString();
    let p = this.docCache.get(key);
    if (!p) {
      p = Promise.resolve(vscode.workspace.openTextDocument(uri)).then(
        d => d,
        () => undefined,
      );
      this.docCache.set(key, p);
    }
    return p;
  }
}

// ---------------------------------------------------------------- helpers

function keyOf(uri: vscode.Uri, s: vscode.DocumentSymbol): string {
  return `${uri.toString()}#${s.selectionRange.start.line}:${s.selectionRange.start.character}`;
}

function toLocation(l: vscode.Location | vscode.LocationLink): vscode.Location {
  if ('targetUri' in l) return new vscode.Location(l.targetUri, l.targetSelectionRange ?? l.targetRange);
  return l;
}

function basename(uri: vscode.Uri): string {
  const p = uri.path.split('/').pop() ?? uri.toString();
  return p.replace(/\.(java|kt|kts|class)$/, '');
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
}

/** Replace comments by spaces so offsets stay valid. */
function blankComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, m => ' '.repeat(m.length));
}

function enclosingChain(list: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol[] {
  const chain: vscode.DocumentSymbol[] = [];
  let cur = list;
  for (;;) {
    const hit = cur.find(s => s.range.contains(pos) || s.selectionRange.contains(pos));
    if (!hit) return chain;
    chain.push(hit);
    cur = hit.children ?? [];
  }
}

/** Some servers return flat SymbolInformation[]; rebuild a tree from range containment. */
function normalizeSymbols(r: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): vscode.DocumentSymbol[] {
  if (r.length === 0) return [];
  if ('selectionRange' in r[0]) return r as vscode.DocumentSymbol[];
  const infos = (r as vscode.SymbolInformation[])
    .map(i => {
      const d = new vscode.DocumentSymbol(i.name, i.containerName ?? '', i.kind, i.location.range, i.location.range);
      return d;
    })
    .sort((a, b) => a.range.start.compareTo(b.range.start) || b.range.end.compareTo(a.range.end));
  const roots: vscode.DocumentSymbol[] = [];
  const stack: vscode.DocumentSymbol[] = [];
  for (const s of infos) {
    while (stack.length && !stack[stack.length - 1].range.contains(s.range)) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(s);
    else roots.push(s);
    stack.push(s);
  }
  return roots;
}

/** Lines between a symbol and the focus line (0 if the focus line is inside it). */
function distance(r: vscode.Range, line: number): number {
  if (line < r.start.line) return r.start.line - line;
  if (line > r.end.line) return line - r.end.line;
  return 0;
}
