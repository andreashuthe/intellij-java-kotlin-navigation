import * as vscode from 'vscode';

/**
 * Results that stay valid across analyses until some *other* source file changes:
 * document symbols of other files, "who implements X" and "what are X's supertypes".
 *
 * Typing in file A only invalidates entries that depend on A's content; entries owned by A
 * (implementations of A's members live in other files) survive, which makes re-analysis
 * after an edit almost free.
 */
export interface CacheEntry<T> {
  /** File whose member/type the entry describes. */
  owner: string;
  /** True if the value points into the owner file itself (then it must be dropped when the owner changes). */
  selfRef: boolean;
  /**
   * Files the value depends on. If given, only changes to these (or to the owner, if selfRef) invalidate the
   * entry – e.g. a type's supertypes only change when its own header or one of the supertype files changes.
   * Without deps, a change to *any* other file invalidates it (e.g. "who implements X" – any file can add a subtype).
   */
  deps?: string[];
  value: T;
}

/** Upper bound for cached symbol trees of other files (oldest are dropped first). */
const MAX_SYMBOL_ENTRIES = 1500;

export class WorkspaceCache {
  private readonly symbols = new Map<string, { stamp: string; value: Promise<vscode.DocumentSymbol[]> }>();
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  // ---------------------------------------------------------------- document symbols

  /** Symbols of a file, reused as long as the file's version (or disk state) is unchanged. */
  symbolsFor(uri: vscode.Uri, fetch: () => Promise<vscode.DocumentSymbol[]>): Promise<vscode.DocumentSymbol[]> {
    const key = uri.toString();
    const stamp = stampOf(uri);
    const hit = this.symbols.get(key);
    if (hit && hit.stamp === stamp) return hit.value;
    const value = fetch();
    const entry = { stamp, value };
    this.symbols.delete(key); // re-insert → Map order = least recently fetched first
    this.symbols.set(key, entry);
    if (this.symbols.size > MAX_SYMBOL_ENTRIES) this.symbols.delete(this.symbols.keys().next().value!);
    // never keep failures (e.g. a cancelled request) in the cache
    value.then(
      r => {
        if (r.length === 0 && this.symbols.get(key) === entry) this.symbols.delete(key);
      },
      () => {
        if (this.symbols.get(key) === entry) this.symbols.delete(key);
      },
    );
    return value;
  }

  // ---------------------------------------------------------------- implementations / supertypes

  get<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }

  set<T>(key: string, owner: vscode.Uri, value: T, selfRef: boolean, deps?: string[]): void {
    this.entries.set(key, { owner: owner.toString(), selfRef, deps, value });
  }

  // ---------------------------------------------------------------- invalidation

  /** Text of `uri` changed (typing, save, external change). */
  documentChanged(uri: vscode.Uri): void {
    const key = uri.toString();
    this.symbols.delete(key);
    for (const [k, e] of this.entries) {
      const own = e.owner === key;
      if (e.deps) {
        // dependency-tracked entry: only its own file (if it points into it) or a dependency matters
        if ((own && e.selfRef) || e.deps.includes(key)) this.entries.delete(k);
      } else if (!own || e.selfRef) {
        // Other files' hierarchy may depend on this file; this file's own entries survive
        // unless they point back into this file (positions may have moved).
        this.entries.delete(k);
      }
    }
  }

  clear(): void {
    this.symbols.clear();
    this.entries.clear();
  }

  get size(): { symbols: number; entries: number } {
    return { symbols: this.symbols.size, entries: this.entries.size };
  }
}

function stampOf(uri: vscode.Uri): string {
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
  return doc ? `v${doc.version}` : 'disk';
}
