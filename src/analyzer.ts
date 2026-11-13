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
const FIELD_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.EnumMember,
]);

/** Annotations of members that are called by a framework – IntelliJ shows no usage count for them either. */
const IMPLICITLY_USED = /@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|BeforeEach|AfterEach|BeforeAll|AfterAll|Before|After|BeforeClass|AfterClass)\b/;

/** A declaration whose usages can be counted ("7 usages"). */
export interface Member {
  /** Stable identity across edits, e.g. `F:Outer.Inner.field` or `M:Type.method(String,int)` */
  key: string;
  name: string;
  kind: 'type' | 'method' | 'field';
  /** Range of the declared name */
  range: vscode.Range;
}

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

/** One type in a method hierarchy (IntelliJ ⌘⇧H). */
export interface HierarchyNode {
  name: string;
  /** Location of the type name */
  uri: string;
  line: number;
  character: number;
  isInterface: boolean;
  /** The type's own declaration of the method, if it declares/overrides it (else it inherits it). */
  method?: { line: number; character: number; abstract: boolean };
  /** The type the hierarchy was opened from */
  current: boolean;
  children: HierarchyNode[];
}

export interface MethodHierarchy {
  /** e.g. `flush()` or `save(Object, Long)` */
  signature: string;
  roots: HierarchyNode[];
}

export interface AnalyzeOptions {
  /** Line the user is looking at: members closest to it are analysed first. */
  focusLine?: number;
  /** Called (repeatedly) with the markers found so far, for progressive rendering. */
  onPartial?: (markers: Marker[]) => void;
  /** Called once the document's symbols are known, with all members whose usages can be counted. */
  onMembers?: (members: Member[]) => void;
  /**
   * Don't wait longer than this for a supertype from a library (class file / decompiled source: Red Hat's server
   * can take 10 s for the first one). The analysis goes on without it; `lateLibraries` settles once it is loaded.
   */
  libraryTimeout?: number;
}

const LATE = Symbol('late');

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
  private readonly late: Promise<ResolvedType | undefined>[] = [];

  /** Library supertypes skipped because of `libraryTimeout`; settles when all of them are loaded (then re-analyse). */
  get lateLibraries(): Promise<boolean> | undefined {
    // true only if one of them could be resolved – otherwise a re-analysis would just wait for it again
    return this.late.length ? Promise.all(this.late).then(r => r.some(x => x)) : undefined;
  }

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
    this.options.onMembers?.(this.collectMembers(doc, symbols));
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

  /** Types, methods and fields of the document (no constructors, no framework-invoked members). */
  private collectMembers(doc: vscode.TextDocument, symbols: vscode.DocumentSymbol[]): Member[] {
    const members: Member[] = [];
    const seen = new Map<string, number>();
    const add = (key: string, s: vscode.DocumentSymbol, kind: Member['kind']) => {
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      members.push({ key: n ? `${key}#${n}` : key, name: bareName(s.name), kind, range: s.selectionRange });
    };
    const visit = (list: vscode.DocumentSymbol[], owner: string) => {
      for (const s of list) {
        const name = bareName(s.name);
        if (TYPE_KINDS.has(s.kind)) {
          const path = owner ? `${owner}.${name}` : name;
          add(`T:${path}`, s, 'type');
          visit(s.children ?? [], path);
        } else if (METHOD_KINDS.has(s.kind)) {
          if (name === owner.split('.').pop() || this.implicitlyUsed(doc, s)) continue; // constructor-like / @Test …
          const sig = this.methodSig(doc, s);
          add(`M:${owner}.${sig.name}(${sig.params?.join(',') ?? '?'})`, s, 'method');
        } else if (FIELD_KINDS.has(s.kind)) {
          add(`F:${owner}.${name}`, s, 'field');
        }
      }
    };
    visit(symbols, '');
    return members;
  }

  /** JUnit lifecycle/test methods and `main` are invoked by a framework / the JVM. */
  private implicitlyUsed(doc: vscode.TextDocument, m: vscode.DocumentSymbol): boolean {
    if (bareName(m.name) === 'main' && /\bstatic\b/.test(this.modifierText(doc, m))) return true;
    if (IMPLICITLY_USED.test(this.modifierText(doc, m))) return true;
    // Some servers start the symbol range after the annotations: look at the lines just above
    for (let l = m.selectionRange.start.line - 1, i = 0; l >= 0 && i < 6; l--, i++) {
      const t = doc.lineAt(l).text.trim();
      if (!t.startsWith('@')) break;
      if (IMPLICITLY_USED.test(t)) return true;
    }
    return false;
  }

  /**
   * Method hierarchy for the method at `pos`: starting at the top-most type(s) declaring the method,
   * all subtypes as a tree, each marked as declaring (abstract or not) or inheriting the method.
   */
  async methodHierarchy(doc: vscode.TextDocument, pos: vscode.Position): Promise<MethodHierarchy | undefined> {
    this.uri = doc.uri;
    const symbols = await this.symbols(doc.uri, true);
    this.docCache.set(doc.uri.toString(), Promise.resolve(doc));
    const chain = enclosingChain(symbols, pos);
    let mi = -1;
    chain.forEach((s, i) => {
      if (METHOD_KINDS.has(s.kind)) mi = i;
    });
    if (mi < 0) return undefined;
    const method = chain[mi];
    const typeSym = chain
      .slice(0, mi)
      .reverse()
      .find(s => TYPE_KINDS.has(s.kind));
    if (!typeSym) return undefined;
    const sig = this.methodSig(doc, method);
    const self: ResolvedType = { uri: doc.uri, symbol: typeSym, name: bareName(typeSym.name), isInterface: this.isInterface(doc, typeSym) };
    const selfKey = keyOf(self.uri, self.symbol);

    // 1) supertypes that declare the method; the top-most of them are the roots
    const ancestors = await this.ancestors(doc.uri, typeSym, doc);
    const declaring: ResolvedType[] = [];
    for (const a of ancestors) if (findMatchingMethod(sig, await this.candidates(a))) declaring.push(a);
    const declaringKeys = new Set(declaring.map(d => keyOf(d.uri, d.symbol)));
    const roots: ResolvedType[] = [];
    for (const d of declaring) {
      const dDoc = await this.document(d.uri);
      const up = dDoc ? await this.ancestors(d.uri, d.symbol, dDoc) : [];
      if (!up.some(u => declaringKeys.has(keyOf(u.uri, u.symbol)))) roots.push(d);
    }
    if (!roots.length) roots.push(self);

    // 2) every subtype of the roots
    const nodes = new Map<string, ResolvedType>();
    const add = (t: ResolvedType) => nodes.set(keyOf(t.uri, t.symbol), t);
    roots.forEach(add);
    add(self);
    for (const r of roots) {
      const subs = await this.implementations(r.uri, r.symbol.selectionRange.start, r.symbol.selectionRange, `T:${r.name}`, false);
      for (const t of subs) {
        const res = await this.resolveTypeAt(vscode.Uri.parse(t.uri), new vscode.Position(t.line, t.character));
        if (res) add(res);
      }
    }

    // 3) edges from each type's direct supertypes (within the hierarchy)
    const parents = new Map<string, string[]>();
    for (const [k, t] of nodes) {
      const tDoc = await this.document(t.uri);
      const direct = tDoc ? await this.directSupertypes(t.uri, t.symbol, tDoc) : [];
      parents.set(
        k,
        direct.map(d => keyOf(d.uri, d.symbol)).filter(pk => pk !== k && nodes.has(pk)),
      );
    }

    // 4) does each type declare the method itself?
    const own = new Map<string, HierarchyNode['method']>();
    for (const [k, t] of nodes) {
      const m = findMatchingMethod(sig, await this.candidates(t));
      if (m) own.set(k, { line: m.symbol.selectionRange.start.line, character: m.symbol.selectionRange.start.character, abstract: m.isAbstract });
    }
    if (!own.has(selfKey)) own.set(selfKey, { line: method.selectionRange.start.line, character: method.selectionRange.start.character, abstract: false });

    // anonymous classes like IntelliJ: "Anonymous in createStyle() in FooTest"
    const labels = new Map<string, string>();
    for (const [k, t] of nodes) {
      if (!/^new\s/.test(t.symbol.name)) continue;
      const outer = enclosingChain(await this.symbols(t.uri), t.symbol.selectionRange.start).filter(s => s !== t.symbol && !s.range.isEqual(t.symbol.range));
      const member = [...outer].reverse().find(s => !TYPE_KINDS.has(s.kind));
      const owner = [...outer].reverse().find(s => TYPE_KINDS.has(s.kind));
      const parts = ['Anonymous'];
      if (member) parts.push(`in ${member.name.replace(/\(.+\)/, '(…)').replace(/\s*:.*$/, '')}`);
      if (owner) parts.push(`in ${bareName(owner.name)}`);
      else parts.push(`in ${basename(t.uri).replace(/\.\w+$/, '')}`);
      labels.set(k, parts.join(' '));
    }

    const build = (k: string, path: Set<string>): HierarchyNode => {
      const t = nodes.get(k)!;
      const nextPath = new Set(path).add(k);
      const children = [...nodes.keys()]
        .filter(c => !nextPath.has(c) && parents.get(c)?.includes(k))
        .map(c => build(c, nextPath))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        name: labels.get(k) ?? t.name,
        uri: t.uri.toString(),
        line: t.symbol.selectionRange.start.line,
        character: t.symbol.selectionRange.start.character,
        isInterface: t.isInterface,
        method: own.get(k),
        current: k === selfKey,
        children,
      };
    };
    // roots: declared roots plus any type whose supertypes are outside the hierarchy (e.g. unresolved library types)
    const rootKeys = [...nodes.keys()].filter(k => !(parents.get(k) ?? []).length);
    const signature = `${sig.name}(${(sig.params ?? []).join(', ')})`;
    return { signature, roots: rootKeys.map(k => build(k, new Set())).sort((a, b) => a.name.localeCompare(b.name)) };
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
    const { result, complete, skipped } = await this.computeDirectSupertypes(uri, type, doc);
    if (!this.token.isCancellationRequested && !skipped) {
      const selfRef = result.some(r => r.uri.toString() === uri.toString());
      // The header text is part of the key; besides that only the supertypes' own files matter – if all of them
      // were resolved. An unresolved one could appear in any file later, so then any change invalidates the entry.
      const deps = complete ? [...new Set(result.map(r => r.uri.toString()))] : undefined;
      this.cache.set(key, uri, result, selfRef, deps);
    }
    return result;
  }

  /** `complete` = every declared supertype could be resolved to source (only then are its dependencies known). */
  private async computeDirectSupertypes(
    uri: vscode.Uri,
    type: vscode.DocumentSymbol,
    doc: vscode.TextDocument,
  ): Promise<{ result: ResolvedType[]; complete: boolean; skipped?: boolean }> {
    let skipped = false;
    const resolve = async (u: vscode.Uri, pos: vscode.Position, hint?: boolean): Promise<ResolvedType | undefined> => {
      const p = this.resolveTypeAt(u, pos, hint);
      const timeout = this.options.libraryTimeout;
      if (u.scheme === 'file' || u.scheme === 'untitled' || !timeout) return p;
      let timer: NodeJS.Timeout | undefined;
      const r = await Promise.race([p, new Promise<typeof LATE>(res => (timer = setTimeout(() => res(LATE), timeout)))]);
      clearTimeout(timer);
      if (r !== LATE) return r;
      skipped = true;
      this.late.push(p.catch(() => undefined));
      return undefined;
    };
    // 0) Java anonymous class (`new Foo() {…}`, symbol name "new Foo() {...}"): its supertype is Foo. The type
    //    hierarchy request at its position would answer for Foo itself.
    const anon = /^new\s+([\w$.]+)/.exec(type.name);
    if (anon) {
      const simple = anon[1].split('.').pop()!;
      const text = this.text(doc);
      const from = Math.max(0, doc.offsetAt(type.range.start) - 300);
      const around = doc.offsetAt(type.selectionRange.start);
      const re = new RegExp(`\\bnew\\s+(?:[\\w$]+\\.)*(${simple.replace(/\$/g, '\\$')})\\b`, 'g');
      let best: number | undefined;
      for (let m; (m = re.exec(text.slice(from, doc.offsetAt(type.range.end))));) {
        const off = from + m.index + m[0].length - m[1].length;
        if (best === undefined || Math.abs(off - around) < Math.abs(best - around)) best = off;
      }
      if (best !== undefined) {
        const defs = await this.limit(() =>
          vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, doc.positionAt(best!)),
        );
        const first = defs?.[0];
        const r = first ? await resolve(toLocation(first).uri, toLocation(first).range.start) : undefined;
        return { result: r ? [r] : [], complete: !!r, skipped };
      }
    }

    // 1) LSP type hierarchy, if the server supports it
    try {
      const items = await this.limit(() =>
        vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', uri, type.selectionRange.start),
      );
      if (items?.length) {
        const supers = await this.limit(() => vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>('vscode.provideSupertypes', items[0]));
        if (supers) {
          const resolved: ResolvedType[] = [];
          let complete = true;
          for (const s of supers) {
            if (s.name === 'Object' || s.name === 'java.lang.Object' || s.name === 'Any') continue;
            const r = await resolve(s.uri, s.selectionRange.start, s.kind === vscode.SymbolKind.Interface);
            if (r) resolved.push(r);
            else complete = false;
          }
          return { result: resolved, complete, skipped };
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
    let complete = true;
    for (const ref of refs) {
      const pos = doc.positionAt(startOff + ref.offset);
      const defs = await this.limit(() =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', uri, pos),
      );
      const first = defs?.[0];
      const r = first ? await resolve(toLocation(first).uri, toLocation(first).range.start) : undefined;
      if (r) resolved.push(r);
      else complete = false;
    }
    return { result: resolved, complete, skipped };
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
export function normalizeSymbols(r: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): vscode.DocumentSymbol[] {
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
