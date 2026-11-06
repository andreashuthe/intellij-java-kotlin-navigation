# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [Semantic Versioning](https://semver.org/).

Add new entries under **Unreleased** — the release workflow turns that section into the new version
and uses it as the GitHub release notes.

## [Unreleased]

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
