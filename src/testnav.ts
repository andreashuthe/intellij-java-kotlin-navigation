import * as vscode from 'vscode';
import { normalizeSymbols } from './analyzer';
import { isTestFile, junitVersionOf, packageOf, rankCandidate, subjectDirFor, subjectNameOf, testDirFor, testNamesFor, testSource } from './naming';

const EXCLUDE = '**/{node_modules,build,target,out,bin,.gradle,.git,.idea}/**';

function baseName(uri: vscode.Uri): string {
  return uri.path.split('/').pop()!.replace(/\.(java|kt|kts)$/, '');
}

/** Source files named like one of `names` (any module, Java or Kotlin). */
async function findClasses(names: string[]): Promise<vscode.Uri[]> {
  if (!names.length) return [];
  const glob = `**/{${names.join(',')}}.{java,kt}`;
  return vscode.workspace.findFiles(glob, EXCLUDE, 50);
}

/**
 * IntelliJ's "Go to Test / Test Subject" (⌘⇧T): jumps between `Foo` and `FooTest`.
 * One match → open it, several → picker, no test yet → offer to create one.
 */
export async function goToTest(uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) return;
  const name = baseName(target);
  const path = target.fsPath;

  if (isTestFile(path, name)) {
    const subject = subjectNameOf(name) ?? name;
    const expected = subjectDirFor(path);
    const found = rank(await findClasses([subject]), expected, path).filter(u => u.toString() !== target.toString());
    if (!found.length) {
      vscode.window.showInformationMessage(`No test subject found for ${name}`);
      return;
    }
    if (found.length === 1) return open(found[0]);
    return pick(`Choose Test Subject for ${name} (${found.length} found)`, found);
  }

  const expected = testDirFor(path);
  const found = rank(await findClasses(testNamesFor(name)), expected, path);
  if (found.length === 1) return open(found[0]);
  return pick(`Choose Test for ${name} (${found.length} found)`, found, target);
}

function rank(uris: vscode.Uri[], expectedDir: string, fromPath: string): vscode.Uri[] {
  const from = fromPath.replace(/\\/g, '/');
  const exp = expectedDir.replace(/\\/g, '/');
  return uris
    .map(u => ({ u, score: rankCandidate(u.fsPath, exp, from) }))
    .sort((a, b) => a.score - b.score || a.u.fsPath.length - b.u.fsPath.length)
    .map(x => x.u);
}

async function open(uri: vscode.Uri): Promise<void> {
  await vscode.window.showTextDocument(uri, { preview: false });
}

async function pick(title: string, uris: vscode.Uri[], createFor?: vscode.Uri): Promise<void> {
  type Item = vscode.QuickPickItem & { uri?: vscode.Uri; create?: boolean };
  const items: Item[] = uris.map(u => ({
    label: `$(symbol-class) ${baseName(u)}`,
    description: vscode.workspace.asRelativePath(u),
    uri: u,
  }));
  if (createFor) items.push({ label: '$(add) Create New Test…', description: `${baseName(createFor)}Test`, create: true });
  const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  if (!picked) return;
  if (picked.create && createFor) await createTest(createFor);
  else if (picked.uri) await open(picked.uri);
}

/**
 * Creates `FooTest` for `Foo` in the matching test source folder (src/main/… → src/test/…),
 * with package declaration and an empty JUnit 4/5 test, and opens it. Returns the new file.
 */
export async function createTest(subject?: vscode.Uri): Promise<vscode.Uri | undefined> {
  const src = subject ?? vscode.window.activeTextEditor?.document.uri;
  if (!src) return undefined;
  const name = baseName(src);
  const lang: 'java' | 'kotlin' = /\.kts?$/.test(src.path) ? 'kotlin' : 'java';
  const testName = `${name}Test`;
  const dir = testDirFor(src.fsPath);
  const file = vscode.Uri.file(`${dir}/${testName}.${lang === 'kotlin' ? 'kt' : 'java'}`);
  if (await exists(file)) {
    await open(file);
    return file;
  }
  const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(src));
  const junit = junitVersionOf(await buildFilesAbove(src));
  const { text, cursorLine } = testSource({ lang, pkg: packageOf(source), testName, junit });
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  const editor = await vscode.window.showTextDocument(file, { preview: false });
  const pos = new vscode.Position(cursorLine, 8);
  editor.selection = new vscode.Selection(pos, pos);
  return file;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Contents of pom.xml / build.gradle(.kts) in the folders above `uri` (up to the workspace folder). */
async function buildFilesAbove(uri: vscode.Uri): Promise<string[]> {
  const root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? '/';
  const out: string[] = [];
  let dir = uri.fsPath.replace(/[\\/][^\\/]+$/, '');
  for (let i = 0; i < 12 && dir.length >= root.length; i++) {
    for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
      try {
        out.push(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(`${dir}/${f}`))));
      } catch {
        /* not there */
      }
    }
    const parent = dir.replace(/[\\/][^\\/]+$/, '');
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// ---------------------------------------------------------------- next / previous member

const MEMBER_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Object,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Field,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Constant,
  vscode.SymbolKind.EnumMember,
]);

const memberLines = new WeakMap<vscode.TextDocument, { version: number; lines: vscode.Position[] }>();

/** IntelliJ's "Next/Previous Method": moves the caret to the next/previous declaration in the file. */
export async function jumpToMember(direction: 1 | -1): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const lines = await memberPositions(editor.document);
  const cur = editor.selection.active.line;
  const target = direction > 0 ? lines.find(p => p.line > cur) : [...lines].reverse().find(p => p.line < cur);
  if (!target) return;
  editor.selection = new vscode.Selection(target, target);
  editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Declaration positions of the document, cached per version (repeated key presses need no server request). */
async function memberPositions(doc: vscode.TextDocument): Promise<vscode.Position[]> {
  const hit = memberLines.get(doc);
  if (hit && hit.version === doc.version) return hit.lines;
  const version = doc.version;
  const raw = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
    'vscode.executeDocumentSymbolProvider',
    doc.uri,
  );
  const starts: vscode.Position[] = [];
  const visit = (list: vscode.DocumentSymbol[]) => {
    for (const s of list) {
      if (MEMBER_KINDS.has(s.kind)) starts.push(s.selectionRange.start);
      // members of nested types count too, but not locals inside method bodies
      if (s.children?.length && !(s.kind === vscode.SymbolKind.Method || s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Constructor)) {
        visit(s.children);
      }
    }
  };
  visit(normalizeSymbols(raw ?? []));
  const lines = [...new Map(starts.map(p => [p.line, p])).values()].sort((a, b) => a.line - b.line);
  if (lines.length) memberLines.set(doc, { version, lines });
  return lines;
}
