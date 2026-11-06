// Tiny regex "language server" for the fixtures: symbols, definition, implementation. No type hierarchy.
const vscode = require('vscode');
const path = require('path');
const dir = path.join(__dirname, '..', 'fixture');
const fs = require('fs');
const files = () => fs.readdirSync(dir).filter(f => f.endsWith('.java')).map(f => vscode.Uri.file(path.join(dir, f)));
const text = uri => fs.readFileSync(uri.fsPath, 'utf8');
function parse(src) {
  const lines = src.split('\n');
  let type;
  const methods = [];
  lines.forEach((l, i) => {
    const t = l.match(/\b(class|interface)\s+(\w+)/);
    if (t && !type) { const c = l.indexOf(t[2]); type = { kind: t[1], name: t[2], line: i, col: c, header: l }; return; }
    const m = l.match(/^\s+(?:@\w+\s+)?(?:public|protected|private)?\s*[\w<>\[\]]+\s+(\w+)\s*\(/);
    if (m && type) methods.push({ name: m[1], line: i, col: l.indexOf(m[1] + '(') });
  });
  return { type, methods, lineCount: lines.length };
}
function symbols(uri) {
  const p = parse(text(uri)); if (!p.type) return [];
  const r = (l, c, n) => new vscode.Range(l, c, l, c + n);
  const ts = new vscode.DocumentSymbol(p.type.name, '', p.type.kind === 'interface' ? vscode.SymbolKind.Interface : vscode.SymbolKind.Class,
    new vscode.Range(0, 0, p.lineCount - 1, 0), r(p.type.line, p.type.col, p.type.name.length));
  ts.children = p.methods.map(m => new vscode.DocumentSymbol(m.name, '', vscode.SymbolKind.Method, new vscode.Range(m.line, 0, m.line + 1, 0), r(m.line, m.col, m.name.length)));
  return [ts];
}
const directSubs = name => files().filter(u => new RegExp(`(extends|implements)[^{]*\\b${name}\\b`).test(parse(text(u)).type.header));
exports.activate = ctx => {
  const sel = { language: 'java' };
  ctx.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(sel, { provideDocumentSymbols: d => symbols(d.uri) }),
    vscode.languages.registerDefinitionProvider(sel, { provideDefinition(d, pos) {
      const w = d.getText(d.getWordRangeAtPosition(pos));
      const u = files().find(f => path.basename(f.fsPath) === w + '.java'); if (!u) return [];
      const p = parse(text(u)); return [new vscode.Location(u, new vscode.Position(p.type.line, p.type.col))];
    } }),
    vscode.languages.registerImplementationProvider(sel, { provideImplementation(d, pos) {
      const p = parse(d.getText()); const w = d.getText(d.getWordRangeAtPosition(pos));
      const out = []; const seen = new Set();
      const walk = (name, method) => { for (const u of directSubs(name)) { const q = parse(text(u)); if (seen.has(q.type.name)) continue; seen.add(q.type.name);
        if (!method) out.push(new vscode.Location(u, new vscode.Position(q.type.line, q.type.col)));
        else { const m = q.methods.find(x => x.name === method); if (m) out.push(new vscode.Location(u, new vscode.Position(m.line, m.col))); }
        walk(q.type.name, method); } };
      walk(p.type.name, w === p.type.name ? undefined : w);
      return out;
    } }),
  );
};

