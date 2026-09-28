# Publishing to npm

Everything needed to release Agent Tokenwatch publicly, in the order it has to
happen. Written while the package is still private, so nothing here assumes a
prior release.

## The name situation

`tokenwatch` is **taken on npm**. As checked on 2026-09-11:

| Name | Status |
|---|---|
| `tokenwatch` | Taken — v0.0.1, published 2025-03-19, never updated since |
| `agent-tokenwatch` | **Free — this package's name** |
| `token-watch` | Free |
| `@mellicci/tokenwatch` | Free (scoped) |

The incumbent is 1,291 bytes unpacked, a single version, no repository field,
a single individual maintainer, described as "Cut your LLM costs by up to 60% by
automatically removing duplicate content." An unimplemented placeholder.

**This costs us almost nothing, because a package name and a command name are
independent.** `package.json` declares:

```json
"bin": { "tokenwatch": "./bin/tokenwatch.mjs", "tokenwatch-codex": "./bin/tokenwatch-codex.mjs" }
```

so publishing as `agent-tokenwatch` still installs a `tokenwatch` command:

```sh
npm install -g agent-tokenwatch   # provides `tokenwatch`
npx agent-tokenwatch doctor       # no install at all
```

### Do not expect npm to hand over the name

npm's [dispute policy](https://docs.npmjs.com/policies/disputes) is explicit:

> npm does not resolve squatting claims on demand. We do not transfer package,
> organization, or username ownership simply because another user wants the name.

Their bar for a squatted *package* is that it "has no genuine function", which
the incumbent arguably meets — but there is no request form for it. The only
formal channel is a trademark violation report through GitHub, which requires a
trademark we do not hold.

The path that actually works is asking the owner directly. Dormant placeholders
are transferred voluntarily often enough to be worth one email, and there is no
leverage if the answer is no. Treat `agent-tokenwatch` as the real name and any
transfer as a bonus.

## Gates before the first publish

Publishing is effectively permanent (see *Mistakes* below), so these are gates,
not suggestions.

### 1. Adapter validation — the one that actually blocks

Claude Code is validated against live payloads and against session transcripts
as ground truth. **Codex CLI and GitHub Copilot CLI are covered only by unit
tests running against synthetic fixtures** written by hand
(`test/fixtures/codex-notify.json`, `codex-otlp.json`, `copilot-status.json`).

A fixture encodes whatever the author assumed. The subagent-count bug is the
worked example: the tests passed while the status line reported 28 subagents for
a session that spawned 3, because the fixtures encoded the assumption that one
`SubagentStop` means one subagent. Real transcripts disproved it; fixtures never
could have.

So before claiming three-agent support:

- run each agent for a real session, then reconcile the recorded events against
  that agent's own transcript or logs, the way `SubagentStart` counts were
  reconciled against Claude Code's transcript;
- confirm cost basis: does the agent report a cost at all, is it cumulative or
  per-call, and is `usage.basis` right for it (`sample` for gauges, `increment`
  for counters)?
- confirm turn boundaries: what event delimits one exchange for that agent?

If an adapter is not field-tested at release time, **say so in the README** and
ship it as provisional rather than quietly implying parity. The place to say it
is the README's *Platform and agent support* table, generated from
`docs/support-matrix.json`: mark the agent `provisional` there.

### 2. Manifest

- [ ] `repository.url` points at the real repository, not a placeholder. npm
      renders this on the package page.
- [ ] `version` is deliberate. Start `0.x` while the CLI surface can still move;
      `1.0.0` is a promise about semver stability.
- [ ] `license` matches the `LICENSE` file (MIT).
- [ ] `engines.node` matches what CI actually tests.
- [ ] `files` covers everything needed at runtime and nothing else.

### 3. Verify what will actually ship

```sh
npm run check          # node --check, full test suite, smoke test
npm run pack:check     # npm pack --dry-run
```

Read the file list. Re-run it before every release rather than trusting this
number: measured just now with `npm pack --dry-run`, it is 61 files, 209.7 kB
packed, 640.3 kB unpacked, zero runtime dependencies. Anything unexpected in
that list is a bug: `files` is an allowlist, but `.npmignore`/`.gitignore`
interactions still surprise people.

Install the tarball somewhere clean and run it end to end:

```sh
npm pack
npm install -g ./agent-tokenwatch-<version>.tgz
tokenwatch doctor
tokenwatch install --agents claude --scope user
```

A package that passes its own tests but fails on a fresh machine usually fails
on an absolute path baked in during development.

### 4. Repository hygiene

- [ ] `CHANGELOG.md` has an entry for the version being released.
- [ ] The support matrix is updated for this release. In
      `docs/support-matrix.json`, set each cell to what was actually observed
      for this build — a hands-on run needs the agent version (`claude
      --version`, `codex --version`, `copilot --version`, or "not recorded")
      and the date; a CI-only cell needs the date of the last green `ci` run —
      set `lastReviewed` to today, then run
      `node scripts/support-matrix.mjs --write` and commit both files.
      `npm test` fails if the README and the data file disagree.
- [ ] `README.md` install instructions use the published name.
- [ ] `SECURITY.md` gives a real contact for reports.
- [ ] No secrets in the history. `~/.tokenwatch/` holds real cost data and
      project HMACs and must never be committed.

## Publishing

The package is released from the public `agent-tokenwatch` repository, and
only a tag pushed there reaches the workflow below.

```sh
npm adduser                 # or `npm login`
npm publish                 # add --access public for a scoped name
```

Enable 2FA on the npm account first; for a CLI that installs hooks into other
people's shells, an account takeover is a supply-chain incident.

### Provenance

`.github/workflows/publish.yml` already does this, gated on a tag whose version
matches `package.json` and on the full `ci.yml` test matrix (ubuntu/macOS/
Windows x Node 20/22/24) passing first. Publishing from GitHub Actions with
`--provenance` attests that the tarball was built from this repository at a
specific commit, and npmjs.com shows a verified badge:

Status at 995c7ae (2026-09-24): this gate cannot currently pass. GitHub Actions
has assigned no runner to either repository since 2026-09-21 (a GitHub billing /
spending-limit annotation, not a code failure — last green run was `5ca5ea0` on
2026-09-18), so the `windows-latest` leg of the matrix has not executed since
then and no code merged after that point, including everything in this release,
has been verified on Windows by CI. Clear the billing block and get a green
`windows-latest` run before relying on this gate to catch a Windows regression.

```yaml
permissions:
  id-token: write        # required for provenance and for OIDC auth below
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      registry-url: https://registry.npmjs.org
  - run: npm ci --ignore-scripts
  - run: npm install -g npm@latest
  - run: npm publish --provenance --access public
```

There is no `NPM_TOKEN` secret: npm 11.5.1+ authenticates over OIDC using the
short-lived token minted from `id-token: write`, once trusted publishing is
configured for this repository and workflow at
`https://www.npmjs.com/package/agent-tokenwatch/access`. Until that is done the
publish step fails to authenticate rather than silently falling back to a
stored credential — a compromised job can still forge a valid attestation for a
bad tarball, so provenance proves where a build ran, not that it should have.

## Versioning

```sh
npm version patch    # 0.1.0 -> 0.1.1, commits and tags
git push --follow-tags
```

Push the release tag in the public repository; that tag is what reaches npm
(see *Publishing* above).

While on `0.x`, treat the **event schema** and the **status-line field names** as
the public API alongside the CLI flags. Renaming a status-line label is a
user-visible break even though no function signature changed, and the ledger is
append-only — records written by an older version must stay readable, which is
why `groupTurns` infers `usage.basis` for records written before that field
existed. Keep that pattern: read old shapes, write new ones.

## Mistakes are close to permanent

- **Unpublish** works only within 72 hours, and only if nothing depends on the
  package. After that npm will not remove it.
- **Deprecate** is the real tool:
  `npm deprecate agent-tokenwatch@0.1.0 "Use 0.1.1; 0.1.0 miscounts subagents"`.
- A published version is immutable. Fix forward with a new version.

## After the first release

- Watch the package page for the rendered README and repository link.
- `npm install -g agent-tokenwatch` on a machine that has never seen the source.
- Nothing in this package phones home, and that is a feature to state plainly in
  the README: it is local, metadata-only telemetry that ships no prices and
  makes no network calls except the Codex OTLP receiver bound to loopback.

## Other ecosystems

npm is the distribution channel for a Node CLI; the rest wrap it.

| Channel | Verdict |
|---|---|
| **npm** | Primary. `npx` lets people try it with no install. |
| **GitHub Releases** | Free, and `npm install -g github:<owner>/agent-tokenwatch` works even before the first npm publish. |
| **Homebrew tap** | Later. A personal tap is easy; homebrew-core requires notability. |
| PyPI, crates.io, apt | No. Wrong ecosystem for a Node CLI. |
