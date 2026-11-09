# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

Add new entries under **Unreleased** — the release workflow turns that section into the new version
and uses it as the GitHub release notes.

## [Unreleased]

## [1.1.1] - 2026-11-09

### Added
- **Go to Test / Test Subject** (IntelliJ's ⌘⇧T): jumps between `Foo` and `FooTest` / `FooTests` / `FooIT` /
  `FooIntegrationTest` / `TestFoo`, preferring the same package under `src/test/…` (picker if several match).
- **Create Test**: creates `FooTest` in the matching test source folder (`src/main/…` → `src/test/…`) with package
  and an empty JUnit 4/5 test (version detected from `pom.xml` / `build.gradle`), Java or Kotlin. Offered in the
  picker when no test exists yet.
- **Next / Previous Member**: jump between classes, fields, constructors and methods of the file.
- *Go to Test* and *Show Usages* in the editor context menu; IntelliJ Nav commands only show up in the command
  palette for Java/Kotlin files.

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
