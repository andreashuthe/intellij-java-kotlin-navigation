// Tiny regex "language server" for the fixtures: symbols, definition, implementation. No type hierarchy.
// Env: MOCK_FIXTURE_DIR (default ../fixture), MOCK_LATENCY_MS (simulated server latency per request, default 0).
// Commands: mockLsp.stats → request counts, mockLsp.reset → reset counts.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const dir = process.env.MOCK_FIXTURE_DIR || path.join(__dirname, '..', 'fixture');
const LATENCY = Number(process.env.MOCK_LATENCY_MS || 0);
const stats = {};
const count = k => (stats[k] = (stats[k] || 0) + 1);
const delay = v => (LATENCY ? new Promise(r => setTimeout(() => r(v), LATENCY)) : v);

const isSource = f => f.endsWith('.java') || f.endsWith('.kt');
const files = () => fs.readdirSync(dir).filter(isSource).map(f => vscode.Uri.file(path.join(dir, f)));
const parseCache = new Map();
function parseFile(uri) {
  const st = fs.statSync(uri.fsPath);
  const key = uri.fsPath;
  const hit = parseCache.get(key);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.p;
  const p = parse(fs.readFileSync(uri.fsPath, 'utf8'), uri.fsPath.endsWith('.kt'));
  parseCache.set(key, { mtime: st.mtimeMs, size: st.size, p });
  return p;
}
const docCache = new Map();
/** Parse an open document once per version (keeps the mock's own CPU cost out of benchmarks). */
function parseDoc(d) {
  const key = d.uri.toString();
  const hit = docCache.get(key);
  if (hit && hit.version === d.version) return hit.p;
  const p = parse(d.getText(), d.languageId === 'kotlin');
  docCache.set(key, { version: d.version, p });
  return p;
}
function parse(src, kotlin) {
  const lines = src.split('\n');
  let type;
  const methods = [];
  lines.forEach((l, i) => {
    const t = l.match(/\b(class|interface|object)\s+(\w+)/);
    if (t && !type) {
      const c = l.indexOf(t[2]);
      type = { kind: t[1], name: t[2], line: i, col: c, header: l };
      return;
    }
    const m = kotlin
      ? l.match(/^\s+(?:[\w]+\s+)*fun\s+(\w+)\s*\(/)
      : l.match(/^\s+(?:@\w+\s+)?(?:public|protected|private)?\s*(?:abstract\s+|static\s+|final\s+)*[\w<>\[\]]+\s+(\w+)\s*\(/);
    if (m && type) methods.push({ name: m[1], line: i, col: l.indexOf(m[1] + '(') });
  });
  return { type, methods, lineCount: lines.length, kotlin };
}
function symbols(p) {
  if (!p.type) return [];
  const r = (l, c, n) => new vscode.Range(l, c, l, c + n);
  const ts = new vscode.DocumentSymbol(p.type.name, '', p.type.kind === 'interface' ? vscode.SymbolKind.Interface : vscode.SymbolKind.Class,
    new vscode.Range(0, 0, p.lineCount - 1, 0), r(p.type.line, p.type.col, p.type.name.length));
  ts.children = p.methods.map(m => new vscode.DocumentSymbol(m.name, '', vscode.SymbolKind.Method, new vscode.Range(m.line, 0, m.line + 1, 0), r(m.line, m.col, m.name.length)));
  return [ts];
}
let filesCache;
const sourceFiles = () => {
  if (!filesCache || Date.now() - filesCache.t > 1000) filesCache = { t: Date.now(), list: files() };
  return filesCache.list;
};
const directSubs = name =>
  sourceFiles().filter(u => {
    const p = parseFile(u);
    if (!p.type) return false;
    return p.kotlin ? new RegExp(`:[^{]*\\b${name}\\b`).test(p.type.header) : new RegExp(`(extends|implements)[^{]*\\b${name}\\b`).test(p.type.header);
  });

exports.activate = ctx => {
  const sel = [{ language: 'java' }, { language: 'kotlin' }];
  ctx.subscriptions.push(
    vscode.commands.registerCommand('mockLsp.stats', () => ({ ...stats })),
    vscode.commands.registerCommand('mockLsp.reset', () => { for (const k of Object.keys(stats)) delete stats[k]; }),
    vscode.languages.registerDocumentSymbolProvider(sel, { provideDocumentSymbols: d => { count('symbols'); return delay(symbols(parseDoc(d))); } }),
    vscode.languages.registerDefinitionProvider(sel, {
      provideDefinition(d, pos) {
        count('definition');
        const w = d.getText(d.getWordRangeAtPosition(pos));
        const u = files().find(f => path.basename(f.fsPath).replace(/\.(java|kt)$/, '') === w);
        if (!u) return delay([]);
        const p = parseFile(u);
        return delay([new vscode.Location(u, new vscode.Position(p.type.line, p.type.col))]);
      },
    }),
    vscode.languages.registerImplementationProvider(sel, {
      provideImplementation(d, pos) {
        count('implementation');
        const p = parseDoc(d);
        const w = d.getText(d.getWordRangeAtPosition(pos));
        const out = [];
        const seen = new Set();
        const walk = (name, method) => {
          for (const u of directSubs(name)) {
            const q = parseFile(u);
            if (seen.has(q.type.name)) continue;
            seen.add(q.type.name);
            if (!method) out.push(new vscode.Location(u, new vscode.Position(q.type.line, q.type.col)));
            else {
              const m = q.methods.find(x => x.name === method);
              if (m) out.push(new vscode.Location(u, new vscode.Position(m.line, m.col)));
            }
            walk(q.type.name, method);
          }
        };
        walk(p.type.name, w === p.type.name ? undefined : w);
        return delay(out);
      },
    }),
  );
};
