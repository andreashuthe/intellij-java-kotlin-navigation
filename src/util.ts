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

const NOT_A_TYPE = /(?:^|[^\w$])(return|new|throw|else|case|yield|await|assert|in|is|as|when|do|typeof|instanceof|not|and|or)$/;

/**
 * True if the identifier at [start, end) of `line` is the name of a method/function *declaration* rather than a call.
 * Some language servers (e.g. Red Hat's Java server) report the declarations of implementing/overriding methods as
 * references; IntelliJ doesn't count those as usages.
 * Heuristic: followed by "(" (optionally generic args) and preceded by a type, a modifier or `fun`/`def`/`func`.
 */
export function isDeclarationSite(line: string, start: number, end: number): boolean {
  if (!/^\s*(<[^()]*>)?\s*\(/.test(line.slice(end))) return false;
  const before = line.slice(0, start).replace(/\/\*.*?\*\//g, '').trimEnd();
  if (!before) return false; // statement starting with a call: foo(x);
  if (/(?:^|\s)(fun|def|func|function)$/.test(before)) return true;
  if (/(?:^|[\s(])fun\s+[\w.<>?, ]*\.$/.test(before)) return true; // Kotlin extension function: fun Foo.bar(
  if (/(?:^|\s)func\s*\([^)]*\)$/.test(before)) return true; // Go method with receiver: func (o *Order) Total(
  if (NOT_A_TYPE.test(before)) return false;
  // a declaration has a (return) type or modifier directly before the name: "public boolean", "List<String>", "int[]", "T"
  return /[\w$>\]?]$/.test(before) && !/(->|::|\.)$/.test(before);
}