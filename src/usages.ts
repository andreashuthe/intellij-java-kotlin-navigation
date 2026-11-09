import * as vscode from 'vscode';
import { Member } from './analyzer';
import { createLimiter } from './util';

interface Entry {
  count?: number;
  /** Count may be outdated (shown anyway until it is refreshed). */
  stale: boolean;
  inflight: boolean;
  /** Bumped on every invalidation, to detect invalidations while a request is running. */
  gen: number;
}

/**
 * Counts usages ("7 usages") lazily: only for members someone actually looks at,
 * at most two `Find References` requests at a time, refreshed after edits once the user pauses.
 */
export class UsageTracker implements vscode.Disposable {
  private readonly entries = new Map<string, Map<string, Entry>>();
  private readonly lastEdit = new Map<string, number>();
  private readonly limit = createLimiter(2);
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private fireTimer?: NodeJS.Timeout;
  private quietTimers = new Map<string, NodeJS.Timeout>();
  /** Number of reference requests sent (diagnostics / tests). */
  requests = 0;

  constructor(private readonly quietDelay: () => number) {}

  dispose(): void {
    clearTimeout(this.fireTimer);
    for (const t of this.quietTimers.values()) clearTimeout(t);
    this.changed.dispose();
  }

  get(uri: vscode.Uri, key: string): { count?: number; stale: boolean } | undefined {
    return this.entries.get(uri.toString())?.get(key);
  }

  /** Make sure counts for these members (positions valid for `doc.version`) are (being) computed. */
  ensure(doc: vscode.TextDocument, members: Member[]): void {
    const uri = doc.uri.toString();
    const sinceEdit = Date.now() - (this.lastEdit.get(uri) ?? 0);
    const delay = this.quietDelay();
    if (sinceEdit < delay) {
      // the user is typing in this file: positions are moving, try again once they pause
      if (!this.quietTimers.has(uri)) {
        this.quietTimers.set(
          uri,
          setTimeout(() => {
            this.quietTimers.delete(uri);
            this.changed.fire();
          }, delay - sinceEdit + 50),
        );
      }
      return;
    }
    let map = this.entries.get(uri);
    if (!map) this.entries.set(uri, (map = new Map()));
    for (const m of members) {
      let e = map.get(m.key);
      if (!e) map.set(m.key, (e = { stale: true, inflight: false, gen: 0 }));
      if (e.inflight || (!e.stale && e.count !== undefined)) continue;
      this.fetch(doc, doc.version, m, e);
    }
  }

  /** Count for one member, waiting for the request if necessary (used by CodeLens resolve). */
  async countNow(doc: vscode.TextDocument, m: Member): Promise<number | undefined> {
    const e = this.get(doc.uri, m.key);
    if (e?.count !== undefined && !e.stale) return e.count;
    const r = await countUsages(doc.uri, m);
    this.requests++;
    return r;
  }

  private fetch(doc: vscode.TextDocument, version: number, m: Member, e: Entry): void {
    e.inflight = true;
    const gen = e.gen;
    this.limit(async () => {
      if (doc.version !== version) return undefined; // positions outdated – retried by the next ensure()
      this.requests++;
      return countUsages(doc.uri, m);
    })
      .then(
        count => {
          if (count === undefined) return;
          e.count = count;
          e.stale = e.gen !== gen;
          this.fireSoon();
        },
        () => undefined,
      )
      .finally(() => {
        e.inflight = false;
      });
  }

  private fireSoon(): void {
    if (this.fireTimer) return;
    this.fireTimer = setTimeout(() => {
      this.fireTimer = undefined;
      this.changed.fire();
    }, 200);
  }

  // ---------------------------------------------------------------- invalidation

  /** The user typed in `uri`: its own counts may change; refresh them after a pause. */
  documentChanged(uri: vscode.Uri): void {
    const key = uri.toString();
    this.lastEdit.set(key, Date.now());
    this.markStale(this.entries.get(key));
  }

  /** A file was saved or changed on disk: usages anywhere may have changed. */
  invalidateAll(): void {
    for (const map of this.entries.values()) this.markStale(map);
  }

  forget(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
    this.lastEdit.delete(uri.toString());
  }

  clear(): void {
    this.entries.clear();
  }

  private markStale(map?: Map<string, Entry>): void {
    for (const e of map?.values() ?? []) {
      e.stale = true;
      e.gen++;
    }
  }
}

/** Usages = references minus the declaration itself. */
export async function findUsages(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location[]> {
  const locs =
    (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeReferenceProvider', uri, pos)) ?? [];
  const key = uri.toString();
  return locs
    .map(l => ('targetUri' in l ? new vscode.Location(l.targetUri, l.targetSelectionRange ?? l.targetRange) : l))
    .filter(l => !(l.uri.toString() === key && l.range.contains(pos)));
}

async function countUsages(uri: vscode.Uri, m: Member): Promise<number> {
  return (await findUsages(uri, m.range.start)).length;
}
