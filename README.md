# IntelliJ Java/Kotlin Navigation for VS Code

IntelliJ-style inheritance navigation for **Java** and **Kotlin**: hints such as `2 implementations`,
`3 overrides` or `↑ EntityRepository` at the end of each declaration, like IntelliJ's code vision.
Designed to sit on top of JetBrains' [Java and Kotlin by IntelliJ IDEA](https://marketplace.visualstudio.com/items?itemName=JetBrains.intellij-server)
extension (`JetBrains.intellij-server`). It also works with any other Java/Kotlin language server
(Red Hat Java, Oracle Java, Kotlin LSP), because it only uses VS Code's standard provider commands.

```java
public interface EntityRepository extends IRepository {   2 implementations
    public boolean contains(Object object);                1 implementation
    public void flush();                                   ↑ IRepository  2 implementations
}
```

| Hint | Meaning (same as IntelliJ) |
|------|----------------------------|
| `N implementations` | Interface / abstract method is implemented in N places |
| `N overrides` | Method is overridden in N subclasses |
| `N inheritors` | Class is subclassed N times |
| `↑ Type` (`+n`) | Method implements / overrides a method of `Type` (and n more ancestors) |

## How navigation works

* **Cmd+Click (Ctrl+Click on Windows/Linux) the hint.** One target → jump, several → picker like
  IntelliJ's "Choose Implementation". (VS Code only runs inlay-hint commands on Cmd/Ctrl+Click.)
* **Hover the member name** → popup with clickable links.
* **Optional CodeLens** above each declaration (`intellijNav.codeLens: true`) — plain click, but uses an extra line.
* **Optional line-number click** (`intellijNav.clickLineNumber: true`) — clicking the line number of such a
  declaration navigates instead of selecting the line.
* Commands (bind your own keys if you like, e.g. IntelliJ's `Ctrl+Alt+B` / `Ctrl+U`):
  * `IntelliJ Nav: Go to Implementation(s) / Overriding Members`
  * `IntelliJ Nav: Go to Super Method / Interface`
  * `IntelliJ Nav: Refresh Navigation Hints`

```jsonc
// keybindings.json (optional)
{ "key": "ctrl+u", "command": "intellijNav.goToSuper", "when": "editorLangId == java" }
```

## How it works

For each Java/Kotlin file in a visible editor:

1. `vscode.executeDocumentSymbolProvider` → classes, interfaces and their methods.
2. **↓ direction**: `vscode.executeImplementationProvider` on each type / non-static, non-private,
   non-final method; results pointing back at the member itself are dropped.
3. **↑ direction**: supertypes come from `vscode.prepareTypeHierarchy` + `vscode.provideSupertypes`.
   If the server doesn't support type hierarchy, the `extends` / `implements` (Kotlin `:`) clause is
   parsed and resolved with `vscode.executeDefinitionProvider`. All ancestors are walked (nearest first)
   and matched by name + parameter types (generic type variables like `T` match any type).
4. Wording: the super member is in an interface or is `abstract` → "implements", otherwise "overrides".

Results are cached per document version, recomputed (debounced) on edits, and all visible files are
refreshed when any Java/Kotlin file is saved. While the language server is still starting/indexing
the extension retries with back-off. Timing info goes to the *IntelliJ Java/Kotlin Navigation* output channel.

## Settings

| Setting | Default | |
|---|---|---|
| `intellijNav.enabled` | `true` | Turn the extension on/off |
| `intellijNav.languages` | `["java","kotlin"]` | Language IDs to analyse |
| `intellijNav.inlayHints` | `true` | Cmd/Ctrl+clickable hints at the end of the line |
| `intellijNav.codeLens` | `false` | Plain-click CodeLens above declarations |
| `intellijNav.clickLineNumber` | `false` | Clicking the line number navigates |
| `intellijNav.showOnTypes` | `true` | Hints on class/interface declarations too |
| `intellijNav.refreshDelay` | `1000` | ms after an edit before recomputing |
| `intellijNav.maxConcurrentRequests` | `4` | Parallel language-server requests per file |

## Develop

```bash
npm install
npm test               # unit tests for signature matching (plain Node)
npm run compile
# F5 in VS Code → "Run Extension" opens an Extension Development Host
npx @vscode/vsce package --allow-missing-repository   # → intellij-java-kotlin-navigation-0.6.0.vsix
```

Install the `.vsix` via *Extensions → … → Install from VSIX…* or
`code --install-extension intellij-java-kotlin-navigation-0.6.0.vsix`.

## Known limitations

* VS Code runs inlay-hint links only on Cmd/Ctrl+Click; use CodeLens if you want a plain click.
* Supertypes from libraries (e.g. `HibernateDaoSupport`) are only matched when the language server
  can open their (decompiled) source.
* Overload resolution uses simple type names; exotic generic overloads can occasionally be ambiguous.
