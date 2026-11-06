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
