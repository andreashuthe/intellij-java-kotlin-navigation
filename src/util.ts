/** Pure helpers without a `vscode` dependency (unit-testable with plain Node). */

/** `decl` starts right after a method name: is the parameter list followed by `{` or `=`? */
export function hasBodyAfterName(decl: string): boolean {
  const open = decl.indexOf('(');
  if (open < 0) return false;
  let depth = 0;
  let i = open;
  for (; i < decl.length; i++) {
    if (decl[i] === '(') depth++;
    else if (decl[i] === ')' && --depth === 0) break;
  }
  return /^\s*(:\s*[^{=\n]+)?\s*[{=]/.test(decl.slice(i + 1));
}

/**
 * Runs at most `max` language-server requests at a time. Once `token` is cancelled,
 * queued requests are dropped instead of being sent to the server.
 */
export function createLimiter(max: number, token?: { isCancellationRequested: boolean }) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    while (active < max && queue.length) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(fn: () => Thenable<T> | Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        const run = token?.isCancellationRequested ? Promise.reject(new CancelledError()) : Promise.resolve().then(fn);
        run.then(resolve, reject).finally(() => {
          active--;
          next();
        });
      });
      next();
    });
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

export interface Pos {
  line: number;
  character: number;
}

/** One text replacement, with `start`/`end` referring to the document before the change. */
export interface TextChange {
  start: Pos;
  end: Pos;
  text: string;
}

/**
 * Where does `p` end up after `change`? `undefined` if the text at `p` was replaced/deleted.
 * Used to keep hints next to their declarations while the user types (until the next analysis).
 */
export function mapPosition(p: Pos, change: TextChange): Pos | undefined {
  const { start, end, text } = change;
  const before = p.line < start.line || (p.line === start.line && p.character < start.character);
  if (before) return p;
  const after = p.line > end.line || (p.line === end.line && p.character >= end.character);
  if (!after) return undefined; // inside the replaced text
  const lines = text.split('\n');
  const added = lines.length - 1;
  const lineDelta = added - (end.line - start.line);
  if (p.line !== end.line) return { line: p.line + lineDelta, character: p.character };
  const last = lines[lines.length - 1].length;
  const character = (added === 0 ? start.character + last : last) + (p.character - end.character);
  return { line: p.line + lineDelta, character };
}

/** Apply several changes in order (each refers to the result of the previous one). */
export function mapPositionAll(p: Pos, changes: readonly TextChange[]): Pos | undefined {
  let cur: Pos | undefined = p;
  for (const c of changes) {
    if (!cur) return undefined;
    cur = mapPosition(cur, c);
  }
  return cur;
}

/** "no usages" / "1 usage" / "7 usages" – IntelliJ's wording. */
export function usageLabel(count: number): string {
  if (count === 0) return 'no usages';
  return count === 1 ? '1 usage' : `${count} usages`;
}
