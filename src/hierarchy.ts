import * as vscode from 'vscode';
import { HierarchyNode, MethodHierarchy } from './analyzer';

export const VIEW_ID = 'intellijNav.methodHierarchy';
const CONTEXT_KEY = 'intellijNav.hasMethodHierarchy';

type Compute = (doc: vscode.TextDocument, pos: vscode.Position) => Promise<MethodHierarchy | undefined>;

/**
 * IntelliJ's "Method Hierarchy" (⌘⇧H) as a tree in the Explorer: every type of the hierarchy,
 * marked whether it declares the method (`defines` / `abstract`) or only inherits it.
 */
export class MethodHierarchyView implements vscode.TreeDataProvider<HierarchyNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HierarchyNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<HierarchyNode>;
  private readonly parents = new WeakMap<HierarchyNode, HierarchyNode>();
  private data?: MethodHierarchy;
  private last?: { uri: vscode.Uri; pos: vscode.Position };

  constructor(private readonly compute: Compute) {
    this.view = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: this, showCollapseAll: true });
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }

  /** Last computed hierarchy (tests / diagnostics). */
  get current(): MethodHierarchy | undefined {
    return this.data;
  }

  /** Show the hierarchy of the method at the cursor (or at `uri`/`pos`). */
  async show(uri?: vscode.Uri, pos?: vscode.Position): Promise<MethodHierarchy | undefined> {
    const editor = vscode.window.activeTextEditor;
    const target = uri && pos ? { uri, pos } : editor ? { uri: editor.document.uri, pos: editor.selection.active } : undefined;
    if (!target) return undefined;
    this.last = target;
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.view.message = 'Computing method hierarchy…';
    const doc = await vscode.workspace.openTextDocument(target.uri);
    const data = await this.compute(doc, target.pos);
    this.data = data;
    if (!data) {
      this.view.description = undefined;
      this.view.message = 'Place the cursor on a method to see its hierarchy.';
    } else {
      this.view.description = data.signature;
      this.view.message = undefined;
      const link = (n: HierarchyNode) => n.children.forEach(c => (this.parents.set(c, n), link(c)));
      data.roots.forEach(link);
    }
    this.changed.fire(undefined);
    // keep focus in the editor (like IntelliJ's tool window) but select the current type in the tree
    const cur = data && find(data.roots, n => n.current);
    if (cur) await this.view.reveal(cur, { select: true, focus: false, expand: true });
    if (editor) await vscode.window.showTextDocument(editor.document, editor.viewColumn);
    return data;
  }

  refresh(): Promise<MethodHierarchy | undefined> {
    return this.last ? this.show(this.last.uri, this.last.pos) : Promise.resolve(undefined);
  }

  getChildren(n?: HierarchyNode): HierarchyNode[] {
    return n ? n.children : (this.data?.roots ?? []);
  }

  getParent(n: HierarchyNode): HierarchyNode | undefined {
    return this.parents.get(n);
  }

  getTreeItem(n: HierarchyNode): vscode.TreeItem {
    const state = stateOf(n);
    const item = new vscode.TreeItem(
      n.current ? { label: n.name, highlights: [[0, n.name.length]] } : n.name,
      n.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = n.current ? `${state.text} · current` : state.text;
    item.iconPath = new vscode.ThemeIcon(n.isInterface ? 'symbol-interface' : 'symbol-class', new vscode.ThemeColor(state.color));
    const where = `${vscode.workspace.asRelativePath(vscode.Uri.parse(n.uri))}:${(n.method?.line ?? n.line) + 1}`;
    item.tooltip = new vscode.MarkdownString(`**${n.name}** — ${state.tooltip}\n\n${where}`);
    const at = n.method ?? n;
    item.command = {
      title: 'Open',
      command: 'vscode.open',
      arguments: [vscode.Uri.parse(n.uri), { selection: new vscode.Range(at.line, at.character, at.line, at.character), preview: true }],
    };
    item.id = `${n.uri}#${n.line}:${n.character}`;
    return item;
  }
}

function stateOf(n: HierarchyNode): { text: string; tooltip: string; color: string } {
  if (!n.method) return { text: 'inherits', tooltip: 'inherits the method', color: 'disabledForeground' };
  if (n.method.abstract) return { text: 'abstract', tooltip: 'declares the method (abstract / interface)', color: 'charts.blue' };
  return { text: 'defines', tooltip: 'defines (implements / overrides) the method', color: 'charts.green' };
}

function find(nodes: HierarchyNode[], pred: (n: HierarchyNode) => boolean): HierarchyNode | undefined {
  for (const n of nodes) {
    if (pred(n)) return n;
    const hit = find(n.children, pred);
    if (hit) return hit;
  }
  return undefined;
}
