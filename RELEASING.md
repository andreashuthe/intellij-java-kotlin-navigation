# Releasing

Releases are fully automated with GitHub Actions:

| Workflow | Trigger | What it does |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | every push / pull request | compile + unit tests on Linux, macOS, Windows · integration tests in a real VS Code · `.vsix` as build artifact |
| [`release.yml`](.github/workflows/release.yml) | **Actions → Release → Run workflow** (or pushing a `vX.Y.Z` tag) | bump version · update `CHANGELOG.md` · build + test · commit + tag `vX.Y.Z` · GitHub release with the `.vsix` · publish to the VS Code Marketplace and Open VSX |

## Making a release

1. Add your changes to the **`## [Unreleased]`** section of [`CHANGELOG.md`](CHANGELOG.md) and push.
2. GitHub → **Actions → Release → Run workflow**, choose `patch` / `minor` / `major`
   (or type an explicit version) and start it.
3. The workflow commits `chore(release): vX.Y.Z`, creates the tag and the
   [GitHub release](../../releases) (notes = the CHANGELOG section, asset = the `.vsix`) and publishes.

Alternative: set the version in `package.json` yourself, push, then push a tag `vX.Y.Z` — the workflow
then skips the bump/commit and only builds, releases and publishes.

> If `master` is protected, allow `github-actions[bot]` to push to it (or use the tag-based variant).

## One-time setup

### 1. GitHub repository

*Settings → Actions → General → Workflow permissions*: **Read and write permissions**.

### 2. VS Code Marketplace (trusted publishing, no token)

Global Azure DevOps PATs are retired on **2026-12-01**, so the workflow publishes with
[Marketplace Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) (GitHub OIDC):

1. Sign in at <https://marketplace.visualstudio.com/manage> and create the publisher **`bits-gmbh`**
   (or change `"publisher"` in `package.json` to your existing publisher ID).
2. Open the publisher → **Trusted Publishing** → **Create** with
   - Repository owner: `andreashuthe`
   - Repository: `intellij-java-kotlin-navigation`
   - Workflow: `release.yml`
   - Environment: *(empty)*
3. In GitHub: *Settings → Secrets and variables → Actions → **Variables*** → add `PUBLISH_MARKETPLACE` = `true`.

### 3. Open VSX (Cursor, Windsurf, VSCodium, Gitpod, …)

1. Sign in at <https://open-vsx.org> with GitHub, sign the publisher agreement, create an access token.
2. Create the namespace once: `npx ovsx create-namespace bits-gmbh -p <token>`.
3. In GitHub add the **secret** `OVSX_PAT` = `<token>` and the **variable** `PUBLISH_OPENVSX` = `true`.
4. After the first successful release you can switch to token-less publishing: open-vsx.org →
   *Settings → Trusted Publishers* → add `andreashuthe/intellij-java-kotlin-navigation`, workflow `release.yml`
   → then delete the `OVSX_PAT` secret.

Without the variables the workflow still creates the tag and the GitHub release — it just doesn't publish.

## Notes

- `@types/vscode` must not be newer than `engines.vscode` in `package.json` (vsce refuses to package otherwise);
  Dependabot is configured to leave it alone.
- "IntelliJ" is a JetBrains trademark — the README contains a non-affiliation note; check the
  [JetBrains brand guidelines](https://www.jetbrains.com/company/brand/) before publishing publicly.
