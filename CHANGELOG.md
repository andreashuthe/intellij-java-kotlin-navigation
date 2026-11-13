# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

Add new entries under **Unreleased** — the release workflow turns that section into the new version
and uses it as the GitHub release notes.

## [Unreleased]

### Fixed
- **Usage counts with Red Hat's Language Support for Java**: declarations of overriding / implementing methods (and
  constructors) are no longer counted as usages – Red Hat's server reports them as references, IntelliJ doesn't.
- **Method Hierarchy**: anonymous classes (`new Foo() { … }`) now appear under their superclass, labeled like IntelliJ
  ("Anonymous in createStyle(…) in FooTest"), instead of as extra roots.

### Changed
- Supertypes from libraries (class files / decompiled sources) no longer hold up the analysis: if the language server
  needs more than 2 s for one (Red Hat: ~10 s for the first JDK class), the markers are shown without it and completed
  as soon as it is loaded.

## [1.2.0] - 2026-11-09

### Added
- **Method Hierarchy** (IntelliJ's ⌘⇧H): tree view in the Explorer from the top-most type declaring the method
  down to all subtypes, each marked *defines* / *abstract* / *inherits*; click to open. Context menu and command palette.
- **Go to Test / Test Subject** (IntelliJ's ⌘⇧T): jumps between `Foo` and `FooTest` / `FooTests` / `FooIT` /
  `FooIntegrationTest` / `TestFoo`, preferring the same package under `src/test/…` (picker if several match).
- **Create Test**: creates `FooTest` in the matching test source folder (`src/main/…` → `src/test/…`) with package
  and an empty JUnit 4/5 test (version detected from `pom.xml` / `build.gradle`), Java or Kotlin. Offered in the
  picker when no test exists yet.
- **Next / Previous Member**: jump between classes, fields, constructors and methods of the file.
- *Go to Test* and *Show Usages* in the editor context menu; IntelliJ Nav commands only show up in the command
  palette for Java/Kotlin files.

### Changed
- **Performance** (measured with the new workflow benchmark `npm run test:perf:workflows`, results unchanged):
  - typing with auto-save: ~4× less CPU, usage counts refreshed once after you pause instead of after every save,
    no repeated supertype lookups (68 → 42 language-server requests, the rest are VS Code's own outline updates)
  - switching tabs: ~4× less CPU – the hover popup is now built on demand instead of being attached to every hint
  - edits in files that are not visible (e.g. a rename refactoring) no longer trigger any analysis until the file is shown
  - saves recompute the visible files debounced instead of immediately
  - cached supertypes are only invalidated when one of their own files changes; bounded symbol cache
  - settings are read once instead of on every keystroke; Method Hierarchy requests can be superseded;
    Next/Previous Member reuses the file's declarations while the file is unchanged

## [1.1.1] - 2026-11-09

### Changed
- Demo GIF in the README now also shows usages.

## [1.1.0] - 2026-11-09

### Added
- **Usages** like IntelliJ's code vision: `7 usages` / `1 usage` / `no usages` at the end of classes, methods and fields
  (also private ones). ⌘/Ctrl + Click shows the usages (one usage → jump straight there). Counted lazily for the members
  on screen only and refreshed when you pause typing. No count for `@Test`/JUnit lifecycle methods and `main`.
  Setting `intellijNav.usages`, command *IntelliJ Nav: Show Usages* (bind it to `Alt+F7` like IntelliJ).
- Usage counts also appear in the optional CodeLens (resolved only for visible lenses).

### Changed
- Hints no longer disappear while typing: they move along with the code and are refreshed when you pause.

## [1.0.1] - 2026-11-06

### Changed
- **Much faster, far fewer language-server requests** (benchmark on a 170-method class hierarchy:
  182 → 12 requests when opening a file, 182 → 10 after an edit; large interfaces 288 → 4, Kotlin classes 150 → 3):
  - overriding methods are found by matching signatures in the subtypes instead of one request per method;
    classes without subtypes need no further requests at all
  - results for unchanged files are cached across edits; work for an outdated version is cancelled as you type
  - a file is no longer analysed twice when it is opened
  - Kotlin classes and members that are `final` by default are skipped
  - members on screen are analysed first and hints appear progressively
- Kotlin overrides of Java methods are matched across `Any`/`Object`, `Int`/`int`, `MutableList`/`List`, …

## [1.0.0] - 2026-11-06

### Added
- Marketplace-ready README with demo GIF, new logo.
- GitHub Actions: CI (build, unit + integration tests, `.vsix` artifact) and a release workflow
  (version bump, tag, GitHub release, optional publishing to the VS Code Marketplace and Open VSX).

## [0.6.0] - 2026-11-05

### Changed
- Renamed to **IntelliJ Java/Kotlin Navigation** (`intellij-java-kotlin-navigation`).

## [0.5.0] - 2026-11-05

### Removed
- Gutter icons (VS Code doesn't let extensions react to clicks on them).

### Changed
- Renamed to *IntelliJ Navigation*.

## [0.4.0] - 2026-11-05

### Changed
- Gutter icons off by default; hover moved to an invisible decoration on the member name.
- Line-number click off by default.

### Removed
- Experimental icon column.

## [0.3.0] - 2026-11-04

### Added
- Experimental clickable icon column in front of the code.

## [0.2.0] - 2026-11-04

### Added
- ⌘/Ctrl-clickable inlay hints at the end of declarations (`2 implementations`, `↑ EntityRepository`).
- Optional CodeLens with plain click.
- Click on the line number navigates.
- Combined picker when a member has both super methods and implementations.

## [0.1.0] - 2026-11-04

### Added
- First version: IntelliJ-style inheritance gutter icons with hover links, implementation / super-method
  commands, type-hierarchy and `extends`/`implements` fallback resolution.
