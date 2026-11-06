import * as vscode from 'vscode';
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

/**
 * Computes inheritance markers for one document, using only standard VS Code
 * provider commands. Every request is answered by whatever language server
 * is active (JetBrains' IntelliJ server, Red Hat Java, Kotlin LSP, ...).
 */
export class Analyzer {
  private symbolCache = new Map<string, Promise<vscode.DocumentSymbol[]>>();
  private docCache = new Map<string, Promise<vscode.TextDocument | undefined>>();
  private ancestorCache = new Map<string, Promise<ResolvedType[]>>();
  private readonly limit: <T>(fn: () => Thenable<T> | Promise<T>) => Promise<T>;

  constructor(
    private readonly token: vscode.CancellationToken,
    maxConcurrent: number,
    private readonly showOnTypes: boolean,
  ) {
    this.limit = createLimiter(maxConcurrent);
  }

  async analyze(doc: vscode.TextDocument): Promise<Marker[]> {
    const symbols = await this.symbols(doc.uri, true);
    if (symbols.length === 0) {
      if (/\b(class|interface|enum|record|object)\b/.test(doc.getText())) throw new EmptySymbolsError('language server not ready');
      return [];
    }
    this.docCache.set(doc.uri.toString(), Promise.resolve(doc));
    const markers: Marker[] = [];
    const jobs: Promise<void>[] = [];
    const visitTypes = (list: vscode.DocumentSymbol[]) => {
      for (const s of list) {
        if (TYPE_KINDS.has(s.kind)) {
          jobs.push(this.analyzeType(doc, s, markers));
        }
        if (s.children?.length) visitTypes(s.children);
      }
    };
    visitTypes(symbols);
    await Promise.all(jobs);
    markers.sort((a, b) => a.range.start.line - b.range.start.line);
    return markers;
  }

  // ---------------------------------------------------------------- types

  private async analyzeType(doc: vscode.TextDocument, type: vscode.DocumentSymbol, out: Marker[]): Promise<void> {
    const isInterface = this.isInterface(doc, type);
    const header = this.headerText(doc, type);
    const isFinalType = /\b(final|record|enum)\b/.test(header) && !isInterface;

    const ancestorsP = this.ancestors(doc.uri, type, doc);

    // Type-level: "is implemented by" / "is subclassed by" (IntelliJ shows only the ↓ icon on types)
    const typeJob = (async () => {
      if (!this.showOnTypes || isFinalType) return;
      const impls = await this.implementations(doc.uri, type.selectionRange.start, type.selectionRange);
      if (impls.length) {
        out.push({
          range: type.selectionRange,
          name: bareName(type.name),
          member: 'type',
          down: { kind: isInterface ? 'I' : 'O', targets: impls },
        });
      }
    })();

    const methods = (type.children ?? []).filter(c => METHOD_KINDS.has(c.kind));
    const methodJobs = methods.map(async m => {
      const modifiers = this.modifierText(doc, m);
      if (/\b(static|private)\b/.test(modifiers)) return;
      const sig = this.methodSig(doc, m);
      const isAbstract = isInterface ? !/\bdefault\b/.test(modifiers) : /\babstract\b/.test(modifiers);

      const marker: Marker = { range: m.selectionRange, name: sig.name, member: 'method' };

      // ↑ implements / overrides
      const upJob = (async () => {
        const ancestors = await ancestorsP;
        const targets: Target[] = [];
        let kind: MarkerKind = 'O';
        for (const anc of ancestors) {
          const ancDoc = await this.document(anc.uri);
          if (!ancDoc) continue;
          const candidates: MethodInfo[] = (anc.symbol.children ?? [])
            .filter(c => METHOD_KINDS.has(c.kind))
            .map(c => {
              const s = this.methodSig(ancDoc, c);
              const mods = this.modifierText(ancDoc, c);
              return { ...s, symbol: c, isAbstract: anc.isInterface ? !/\bdefault\b/.test(mods) : /\babstract\b/.test(mods) };
            })
            .filter(c => !/\b(static|private)\b/.test(this.modifierText(ancDoc, c.symbol)));
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
        if (isFinalType || /\bfinal\b/.test(modifiers)) return;
        const impls = await this.implementations(doc.uri, m.selectionRange.start, m.selectionRange);
        if (impls.length) marker.down = { kind: isInterface || isAbstract ? 'I' : 'O', targets: impls };
      })();

      await Promise.all([upJob, downJob]);
      if (marker.up || marker.down) out.push(marker);
    });

    await Promise.all([typeJob, ...methodJobs]);
  }

  private isInterface(doc: vscode.TextDocument, type: vscode.DocumentSymbol): boolean {
    if (type.kind === vscode.SymbolKind.Interface) return true;
    return /\binterface\b/.test(this.modifierText(doc, type));
  }

  /** Text between the start of the symbol (annotations/modifiers) and its name. */
  private modifierText(doc: vscode.TextDocument, s: vscode.DocumentSymbol): string {
    const start = s.range.start.isBefore(s.selectionRange.start) ? s.range.start : s.selectionRange.start.with({ character: 0 });
    return stripComments(doc.getText(new vscode.Range(start, s.selectionRange.start)));
  }

  /** Text from the type name up to (not including) the opening `{`. */
  private headerText(doc: vscode.TextDocument, type: vscode.DocumentSymbol): string {
    const startOff = doc.offsetAt(type.selectionRange.end);
    const text = doc.getText().slice(startOff, startOff + 4000);
    const brace = text.indexOf('{');
    return this.modifierText(doc, type) + ' ' + stripComments(brace >= 0 ? text.slice(0, brace) : text.split('\n')[0]);
  }

  private methodSig(doc: vscode.TextDocument, m: vscode.DocumentSymbol): MethodSig {
    const name = bareName(m.name);
    let params = typesFromSymbolName(m.name);
    if (!params) {
      const startOff = doc.offsetAt(m.selectionRange.end);
      const after = doc.getText().slice(startOff, startOff + 2000);
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
    const text = doc.getText().slice(startOff, startOff + 4000);
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

  private async implementations(uri: vscode.Uri, pos: vscode.Position, self: vscode.Range): Promise<Target[]> {
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
    const key = uri.toString();
    let p = this.symbolCache.get(key);
    if (!p) {
      p = this.limit(() =>
        vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri),
      ).then(
        r => normalizeSymbols(r ?? []),
        err => {
          if (strict) throw err;
          return [];
        },
      );
      this.symbolCache.set(key, p);
    }
    return p;
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

function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    queue.shift()!();
  };
  return <T>(fn: () => Thenable<T> | Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
