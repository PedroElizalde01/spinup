# Spinup product plan

Single entry point for the next implementation passes. Covers the CLI (`runit` repo,
binary `spinup`), the website (`../runitfront`), branding, open defects, and the
feature roadmap that turns Spinup into a dependable, high-end developer tool.

Written **2026-09-16** against branch `fix/m1-file-safety`, HEAD `8f0480c`,
package version `0.3.0`. Website repo HEAD `608f4e7` with two uncommitted files.

| Baseline check | Result |
|---|---|
| `bun run check` | Pass (source only, tests not typechecked) |
| `bun test` | 81 pass, 0 fail, 152 assertions, 10 files |
| Website `git status` | `components/terminal-scene.tsx` and `lib/content.ts` modified, uncommitted |

Companion documents, kept as historical evidence and not rewritten:

- `RUNIT_REVIEW.md`: original audit, findings F01–F23, proposals P01–P11, cuts C1–C5.
- `SPINUP_IMPLEMENTATION_HANDOFF.md`: per-finding fix guidance and acceptance criteria.
  Its status column predates commits `209d45d` and `8f0480c`. Section 3 below is the
  current ledger and supersedes it where they differ.

ID conventions in this file. `F##`/`R#`/`P##`/`G##` are retained from the review and
handoff. `B##` are branding and rename items, `N##` are new defects found today,
`E##` are enterprise feature items, `W##` are website items, `Q#` are open decisions.

---

## 1. Product definition

Spinup registers a project once, generates `.spinup.yml` from what is actually in the
repo, installs a shim command in `~/.local/bin`, and reopens the full dev environment
(simple process group or tmux workspace) from any directory.

Enterprise-level means, concretely:

1. **Never destroys user state.** No foreign file overwritten, no unowned tmux session
   killed, no config rewritten without preview and backup, no secret in scrollback.
2. **Every launch is explainable.** `--plan`, `--graph`, `--env`, `--doctor` describe
   exactly what will run, in what order, with which env, and why each command was chosen.
3. **Deterministic and scriptable.** `--json` on every inspection command, stable exit
   codes, no interactive prompt unless a TTY is present.
4. **Verified distribution.** Checksummed and signed releases, native smoke tests on
   every advertised platform, atomic installer, self-update.
5. **Team-ready.** Shared `.spinup.yml` with editor schema support and per-user
   overrides, readiness conditions so a stack comes up in the right order.

Out of scope, unchanged from the review (N1–N6): network database, web dashboard or
cloud sync, AI-generated commands as an execution path, universal supervisor framework,
native Windows without a coherent design, rewrite in another language.

---

## 2. Branding and rename (B)

The GitHub README banner is done. Everything else below still says RUNIT or `runit`.

### 2.1 CLI repo

| ID | Item | Location | Fix |
|---|---|---|---|
| B01 | ~~Setup card prints the RUNIT half-block glyph~~ | done `05d6c2a` | `src/ui/brand.ts` holds the glyph. |
| B02 | ~~No banner on `spinup` with no arguments or `--help`~~ | done `05d6c2a` | Bare `spinup` prints help; banner colored only on a TTY. |
| B03 | ~~README says "Renamed from `spinup`"~~ | done `05d6c2a` | |
| B04 | ~~Repo's own `.spinup.yml` has `name: runit`~~ | done `05d6c2a` | |
| B05 | ~~`RunitConfig` type name~~ | done `05d6c2a` | |
| B06 | ~~Comments and canary names still say runit~~ | done `05d6c2a` | Compatibility names kept. |
| B07 | ~~`favicon.svg` / `favicon.ico` draw an "r" glyph~~ | done `05d6c2a` | S mark, ICO is one PNG entry. |
| B08 ✓ | ~~GitHub repository is still `PedroElizalde01/runit`~~ renamed to `spinup` 2026-09-16 | remote, `install.sh:6`, README install URL, website URLs | See Q2. If renamed to `spinup`, GitHub redirects old URLs, but update `install.sh` `REPO`, README, and website constants anyway and keep a comment that the old name redirects. |
| B09 ✓ | Old `runit` release assets (installer refuses tags before v0.3.0) | GitHub Releases v0.1.1–v0.2.2 | Leave as-is. `install.sh --version` for pre-rename tags must fail with "pre-rename release, install v0.3.0 or newer" (F22). |

**CLI glyph.** Same 2-row half-block font as the current RUNIT mark, 22 columns, fits
the 60-column card:

```
█▀▀ █▀█ █ █▄ █ █ █ █▀█
▄▄█ █▀▀ █ █ ▀█ █▄█ █▀▀
```

**Banner for `spinup` with no arguments.** Printed to stdout, then Commander help:

```
█▀▀ █▀█ █ █▄ █ █ █ █▀█   v0.3.0
▄▄█ █▀▀ █ █ ▀█ █▄█ █▀▀   spin up any project from anywhere

Usage: spinup [options] [alias]
...
```

Implementation note: Commander's `addHelpText("beforeAll", ...)` covers `--help` and the
no-argument path if the action throws the existing "An alias is required" error through
`program.help()` instead. One helper, one call site, guarded by `process.stdout.isTTY`.

### 2.2 Website (`../runitfront`)

Every user-facing string, constant, and identifier:

| ID | Item | File | Fix |
|---|---|---|---|
| W01 ✓ | `"name": "runit-website"` | `package.json`, `package-lock.json` | `spinup-website`. |
| W02 ✓ | Metadata title `RUNIT`, description mentions `.runit.yml` | `app/layout.tsx:21–24` | `SpinUp`, description: "SpinUp registers a project once, generates .spinup.yml, and reopens your dev environment from anywhere." |
| W03 ✓ | Hero headline "Run it anywhere.", copy mentions `.runit.yml` | `components/hero-section.tsx` | Headline "Spin up anywhere." Copy references `.spinup.yml`. |
| W04 ✓ | Hero terminal command `runit my-app` and ASCII `RUNIT` letter panel | `lib/content.ts` (`HERO_TERMINAL.registerCommand`, `REGISTER_OUTPUT_LINES`) | `spinup my-app`; render the SPINUP glyph rows inside the panel. See W09 on the uncommitted ASCII change. |
| W05 ✓ | Stack section copy "RUNIT reads the workspace" | `components/stack-section.tsx` | "SpinUp reads the workspace". |
| W06 ✓ | `aria-label="RUNIT home"` | `components/top-nav.tsx:8` | `SpinUp home`. |
| W07 ✓ | Screen-reader text "Animated terminal showing runit registering" | `components/terminal-scene.tsx:506` | `spinup`. |
| W08 ✓ | `User-Agent: runit-website` | `app/page.tsx:21` | `spinup-website`. |
| W09 ✓ | Uncommitted diff replaced `✓ ○ ▲ ●` with `[ok] ... * -` and box-drawing with `+-|` for Windows font rendering | `terminal-scene.tsx`, `lib/content.ts` | Decide (Q3). Recommended: keep box-drawing and `✓`, add `font-family` fallback chain ending in `"Cascadia Mono", Consolas, monospace` and `font-variant-ligatures: none`. IBM Plex Mono is loaded via next/font, so glyph coverage is the loaded font's, not the OS's. Verify on Windows Chrome and Edge before committing either way. |
| W10 ✓ | Brand icon "r" path | `components/brand-icon.tsx`, `app/icon.svg` | New S mark from Q1, same file in both places. |
| W11 ✓ | GitHub, releases, install, and API URLs point to `runit` | `lib/content.ts:1–7` | Follow Q2. |
| W12 ✓ | README title "RUNIT Website" | `README.md` | `SpinUp Website`. |
| W13 ✓ | Remote repo `runit-front` | GitHub | Renamed to `spinup-front` 2026-09-16; `origin` updated. |

Tagline options for W03 and B02, pick one and use it in both places: "Spin up anywhere.",
"One command. Whole stack.", "Your dev environment, from any directory."

---

## 3. Defect ledger (current status)

Status reflects today's source and the two commits after the handoff. "Open" means no
code has landed. "Partial" means part of the acceptance criteria is met.

### 3.1 P0 safety

| ID | Defect | Status | Remaining work |
|---|---|---|---|
| F01/R1 | Shim writes through symlinks, weak ownership evidence | **Fixed in `8f0480c`** | Add the concurrent same-alias creation test (two OS processes). Keep G01. |
| R7 | Config replacement widened `0600` to `0644` | **Fixed in `8f0480c`** | Verify the backup file created by F06 inherits the same policy. |
| R4 | Real v0.2.2 wrappers not migrated, 66-char collision keys | **Fixed in `8f0480c`** | Run case-insensitive rename cases natively on macOS (F21). |
| F19 | Registry/shim/config mutation not atomic across files | **Fixed 2026-09-16** | Wrapper first, config second, registry last, with rollback of a created wrapper. Removal takes the wrapper before the entry. Lock records holder pid; recovered only when that pid is gone. Two-process contention and injected failures tested. |
| F05/R6 | Interactive tmux edit prunes deps against one window, reorders, injects layout | **Fixed 2026-09-16** | In-place window edits, removed-only dependency stripping across windows, no-op save skips the write, mode conversion asks before dropping windows, YAML Document patching keeps comments. |
| F06 | Regeneration preview misses env/order/window changes; first `--regenerate` skips confirm | **Fixed 2026-09-16** | One path for registered and unregistered. Env keys (no values), order and window changes previewed. Fails closed without a TTY. Private `.bak` of the previous bytes. |
| F02/R2 | Exact-name tmux session is killed regardless of ownership | **Fixed 2026-09-16** | Sessions carry `@spinup_project` and `@spinup_action`. Same owner attaches, anything else fails without touching the session. Kill path removed. |
| F03 | Execa errors echo `-e KEY=secret` argv | **Fixed 2026-09-16** | `TmuxError` at the shared invocation boundary: operation, target, exit status, redacted stderr, no cause. Failure-path test asserts the secret is absent from message, stack and JSON. |
| F08/R3 | Descendants survive SIGTERM, exit code discarded, SIGINT/SIGTERM not distinguished | **Fixed 2026-09-16** | Every task in its own group, liveness by signal 0, SIGTERM then SIGKILL after 3s. Task status passes through; 130/143 via `Interrupted`. Out-of-process fixture tests. |

### 3.2 P1 execution contract

| ID | Defect | Status | Remaining work |
|---|---|---|---|
| F15/R5 | Env precedence, `.env.development` for every action, global mutation | **Fixed 2026-09-16** | One effective env for both backends; session-level `-r` hides stale server keys; `TMUX_PANE` left to tmux. Source-mode Bun dotenv policy still undocumented. |
| F16 | Diagnostics exit 0 on unusable env | **Fixed 2026-09-16** | Strict load validation covers cycles and blank commands; `--check`/`--doctor` exit 2 for the selected action. |
| F18 | No `--action` selector, shim forces `--start` | **Fixed 2026-09-16** | `--action` everywhere; `--start` is the marker and yields to management flags; explicit start never registers; doctor and the setup card list actions. |
| F17 | Validation not strict: unknown keys dropped, cycles pass, blank commands pass, wrong pane indexes in errors | **Fixed 2026-09-16** | Strict schema, cycle detection at load, real pane paths, graph with real edges, plan with order/cwd/deps/delays. |
| F09 | Output prefixer ignores `sink.write()` backpressure | **Fixed 2026-09-16** | `LinePrefixer` Transform in a pipe chain; slow-sink regression. |
| F10 | `dependsOn` is start order, not readiness | **Fixed 2026-09-16** | E03 `ready` conditions; `dependsOn` without a condition keeps its meaning; delays no longer serialize unrelated services. |
| F11 | tmux assumes `base-index 0`, ignores small terminals | **Fixed 2026-09-16** | Ids were already used; session created with terminal size or 200x50; base-index 1 regression; `TmuxError` names the failing split. |

### 3.3 P1 detection and Compose

| ID | Defect | Status | Remaining work |
|---|---|---|---|
| F12 | Detection ignores root scripts, workspace globs, declared package manager; invents `npm start` | **Fixed 2026-09-16** | Launchers, root orchestrator, declared globs with exclusions, `packageManager` field, no test/check scripts, verified Python entries, prompt or fail when nothing is found. |
| F13 | Service names collide (`app` node + `app` python, same basenames) | **Fixed 2026-09-16** | Unique by runtime or path before inference; Compose keys untouched because Compose is one service. |
| F14 | Compose file precedence wrong, static parsing misses overrides/profiles, one `up` per service | **Fixed 2026-09-16** | `docker compose config` with labelled static fallback, override and profiles honored, one `docker compose up`. Nothing runs `down`. |

### 3.4 Distribution and docs

| ID | Defect | Status | Remaining work |
|---|---|---|---|
| F21 | No native macOS/ARM execution in CI, tests not typechecked, mutable action tags | **Fixed 2026-09-17** | Add `macos-14` (arm64) and `macos-13` (x64) smoke jobs running the built binary. `tsconfig.test.json` with `bun-types`, `tsc -p` in CI. Pin `upload-artifact`, `download-artifact`, `action-gh-release` to SHAs. |
| F22 | No checksum verification, non-atomic replace, no libc check, bad option-arg errors | **Fixed 2026-09-17** | Checksums, staged atomic install, musl builds and detection, option validation, version check of the staged binary. |
| F23 | README rename paragraph wrong, examples incomplete, remediation table stale | **Fixed 2026-09-17** | docs/ with validated examples; RUNIT_REVIEW.md and the handoff are marked historical and point here. |

### 3.5 New defects found today (N)

| ID | Defect | Location | Fix |
|---|---|---|---|
| N01 | ~~`spinup --list` output is bare~~ | done `60a4b11` | |
| N02 | ~~done `2f069e2`~~ Website fetches GitHub API on every request with `force-dynamic` and `no-store`; unauthenticated limit is 60/hour per IP, so the badge disappears under any traffic | `app/page.tsx` | `next: { revalidate: 600 }` and drop `force-dynamic`. Fallback to `RELEASES_URL` already exists. |
| N03 | ~~stdout/stderr mixing~~ | done `60a4b11` | `src/ui/output.ts` `emit()`; migration notices stay on stderr. |
| N04 | ~~`--interactive` prompts are invoked without checking `process.stdin.isTTY`~~ | done `cad0c09` | |
| N05 | ~~no version field~~ | done `53ceab6` | `version: 1` written; newer refused. |
| N06 | ~~`bun test` prints launch progress lines~~ | done 2026-09-17 | `test/setup.ts` preload silences console.log; `SPINUP_TEST_VERBOSE=1` shows it. |
| N07 | Website has no `robots.txt`, `sitemap`, OG image, or canonical URL | `app/` | See W14–W17. |
| N08 | ~~Website `tsconfig.tsbuildinfo` is committed~~ | done `2f069e2` | |

---

## 4. Enterprise feature roadmap (E)

Ordered by dependency, not by appeal. Each item names its precondition and its
acceptance check. Items marked "P##" map to review proposals.

### 4.1 Contract and scripting

| ID | Feature | Depends on | Acceptance |
|---|---|---|---|
| E01 ✓ | **`--action <name>`** on start, plan, graph, env, check, doctor (P01, F18) | F17 | `spinup api --action prisma-migrate` runs that action; unknown action fails before any write. |
| E02 ✓ | **`--json`** on list, plan, graph, env, check, doctor (P05) | N03 | stdout is only JSON, diagnostics on stderr, values masked, exit codes unchanged. Schema documented in `docs/json.md`. |
| E04 ✓ | **Exit code contract** | F08 | 0 success, 1 usage/config, 2 missing tool, task exit code passthrough, 130/143 for signals. Documented and tested. |
| E05 ✓ | **`--dry-run`** on start | E01 | Prints resolved commands, cwd, env key origins, tmux layout. Nothing spawned. |
| E13 ✓ | **Shell completion** `spinup completion bash|zsh|fish` (P08) | E01 | Completes aliases from registry and actions from the alias's config. No daemon. |
| E14 ✓ | **`NO_COLOR`, `--no-color`** | N03 | Respected everywhere the card or prefixes are colored. |

### 4.2 Lifecycle

| ID | Feature | Depends on | Acceptance |
|---|---|---|---|
| E03 ✓ | **Readiness conditions** (P03, F10): `waitFor: { port: 5432 }`, `{ http: "http://localhost:3000/health" }`, `{ exit: 0 }`, `{ log: "ready" }`, each with `timeout` | F17 | Postgres → migrate (exit 0) → api (port) → web sequence starts in order and fails fast with the failing condition named. `dependsOn` alone keeps current start-order meaning. |
| E07 ✓ | **`--status`, `--attach`, `--stop`, `--restart [service]`** on owned sessions only (P02) | F02 | Unowned session never touched. `--restart api` restarts one pane and reports dependents that may need restart. |
| E08 ✓ | **Run local config without registering**: `spinup --start` in a directory with `.spinup.yml` (P09) | F02 | No registry or shim writes. tmux session named from config `name` with ownership tags. |
| E09 ✓ | **Opt-in per-service logs** `--logs` via tmux `pipe-pane` and simple-mode tee (P11) | E07 | Files under `$XDG_STATE_HOME/spinup/logs/<alias>/<service>.log`, `0600`, bounded retention, never replaces an existing user pipe. |
| E10 ✓ | **Port preflight** (P07) | E02 | `--check` reports ports declared in config or Compose that are already bound, with owning PID when readable. Never kills. |

### 4.3 Detection

| ID | Feature | Depends on | Acceptance |
|---|---|---|---|
| E06 ✓ | **Recognize project-owned launchers** (P10): `bin/dev`, `Makefile`/`justfile`/`Taskfile.yml`/`mise.toml` `dev` task, `Procfile`, root `dev` script | F12 | Offered before workspace expansion. Never both a root orchestrator and its children. Nothing executed during scan. |
| E11 ✓ | **Detection explanations** (P04): every generated command carries `# from: apps/api/package.json scripts.dev` as a YAML comment | F12 | `--doctor` shows origin per service. |
| E15 | **Runtime managers**: respect `.tool-versions`, `mise.toml`, `.nvmrc`, `.python-version`, `uv.lock`, Poetry, venv (P06) | F16 | `--check` reports the version the project declares vs. the one on PATH. No auto-install. |
| E16 ✓ | **More stacks**: Go (`go run ./cmd/...` only when a `main` package is found), Rust (`cargo run` only for bin targets), Java/Kotlin (Gradle/Maven `bootRun`), Ruby (`bin/rails s`, `Procfile.dev`), PHP (`artisan serve`), Deno, Bun | E06, F13 | One fixture per stack in `test/fixtures/`. A library-only repo produces no runnable guess. |

### 4.4 Configuration

| ID | Feature | Depends on | Acceptance |
|---|---|---|---|
| E17 ✓ | **JSON Schema for `.spinup.yml`** (hosted on GitHub raw until Q6) generated from the Zod schema, published at `https://<site>/schema/v1.json`, `# yaml-language-server: $schema=` line in generated files | F17, N05 | Schema round-trips every fixture. Editor completion works in VS Code with the YAML extension. |
| E18 | **Per-user overrides** `.spinup.local.yml` (gitignored) merged over the shared file: env, cwd, extra panes | F17 | Merge documented. `--plan` shows which fields came from the override. |
| E19 | **Config `version` and migrations** | N05 | Loading a newer version fails with "upgrade spinup". Older versions migrate on save with a preview. |
| E20 ✓ | **`spinup init`** (as `--init`): interactive first-time setup that previews alias, root, config path, shim destination, and lets the user pick or edit each detected command before writing (P08) | E11 | Cancellable with zero writes. Noninteractive falls back to current behavior. |
| E21 ✓ | **Explicit project path and relink**: `spinup my-app --path ~/code/my-app`, `spinup my-app --relink` for moved repos and worktrees (P08) | F19 | Relink confirms before replacing, never orphans a shim. |

### 4.5 Distribution and trust

| ID | Feature | Depends on | Acceptance |
|---|---|---|---|
| E12 ✓ | **Checksums and provenance**: `SHA256SUMS` in every release, `install.sh` verifies before install, SLSA provenance via `actions/attest-build-provenance`, optional `cosign` verify | F21 | Corrupted or truncated download leaves the previous binary intact. `gh attestation verify` passes on a published asset. |
| E22 ✓ | **Atomic install**: stage in `$INSTALL_DIR/.spinup.tmp.XXXX`, `mv` on the same filesystem, keep old binary on any failure; explicit musl/glibc check with a clear message | E12 | Interrupted install leaves the old binary runnable. |
| E23 ✓ | **`spinup --update`** (or `spinup update`): reuses the installer logic, verifies checksum, prints changelog excerpt | E12, E22 | Downgrade refused unless `--version` given. |
| E24 ◐ | **Package channels** (Homebrew formula and release job done; needs the tap repo and HOMEBREW_TAP_TOKEN; npm and AUR deferred): Homebrew tap (`PedroElizalde01/homebrew-spinup`), npm `spinup` if the name is available (Q4), AUR `spinup-bin` | E12 | Each channel installs the same checksummed asset. |
| E25 ✓ | **Native CI matrix**: `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-13`, `macos-14`, each runs the built binary through register, plan, harmless launch, failure exit code, and cleanup | F21 | A failing regression blocks `publish`. |
| E26 ✓ | **Man page and `docs/`**: generated from Commander help plus hand-written config reference | E17 | `man spinup` installed by Homebrew formula. |
| E27 | **Opt-in, off-by-default crash reports** (never usage telemetry): `SPINUP_CRASH_REPORT=1` writes a redacted report locally for the user to attach to an issue | F03 | No network call is ever made by Spinup itself. |

### 4.6 Simplifications to make while touching the code (from review §6)

| ID | Cut |
|---|---|
| C2 ✓ | Blank-command autofix is gone (removed with strict validation). |
| C3 ✓ | `Pane` is an alias of `Task`; one runnable schema serves both. |
| C4 ✓ | `expandHome`, `collectDependencies` and the unused scan flags are removed. |
| C5 ✓ | The local `@inquirer/prompts` type override is deleted; shipped types are used. |

---

## 5. Website roadmap (W)

The site is a single landing page. For a high-end product it needs to be the
documentation and trust surface as well.

| ID | Item | Notes |
|---|---|---|
| W14 ✓ | **Docs section** at `/docs`: install, quick start, config reference (generated from E17 schema), commands, env precedence, readiness, tmux workflow, upgrade from runit | Markdown in repo, rendered by Next with MDX or `next-mdx-remote`. Single source: pull `docs/` from the CLI repo at build time or as a git submodule (Q5). |
| W15 ✓ | **Install matrix**: OS/arch table, checksum snippet, Homebrew/npm/AUR tabs once E24 ships | Read release assets from the GitHub API with revalidation (N02). |
| W16 ✓ | **Changelog page** (renders CHANGELOG.md) rendered from GitHub Releases | Same cached fetch as N02. |
| W17 | **SEO and sharing**: `metadata.metadataBase`, OpenGraph and Twitter cards, generated OG image with the SPINUP glyph (`app/opengraph-image.tsx`), `robots.ts`, `sitemap.ts`, canonical URL | Requires a decided domain (Q6). |
| W18 ✓ | **Hero terminal shows real output**: replay the actual `spinup my-app` card and a `--plan` run rather than hand-typed frames | Generate the frames from a fixture run in CI and commit the JSON, so the site never drifts from the CLI. |
| W19 | **Accessibility pass**: `prefers-reduced-motion` on the terminal animation and section reveal, focus styles on copy button, contrast check on dim terminal text | `audit` skill once the rename lands. |
| W20 | **Light/dark**: currently dark only. Add `prefers-color-scheme` light palette or explicitly commit to dark with a `color-scheme: dark` meta | Decide with Q1 brand direction. |
| W21 | **Schema hosting**: serve `public/schema/v1.json` from E17 | Static file, immutable URL per version. |

---

## 6. Sequencing

Milestones from the handoff are kept. Branding is folded into M1 because it is small
and the current mismatch is visible to every user.

| Milestone | Scope | Gate |
|---|---|---|
| **M1: safety + brand** (current branch) | **Done 2026-09-16** except native macOS runs. Closed F19, F05, F06, F02, F03, F08. Landed B01–B07, W01–W13, N02, N04, N08. Tests typecheck via `tsconfig.test.json`. | G01–G06, G08. All tests green on Linux CI. Website builds with zero `runit` strings outside the migration notes. |
| **M2: contract** | **Done 2026-09-16.** F17, F18, F09, F11, F15 tmux env, F16 remainder. E01, E02, E04, E05, E14, N01, N03, N05. | G07 met: `test/cli.test.ts` drives the real CLI for `--json`, `--action`, exit codes 1/2/42, `--dry-run`, shim routing. |
| **M3: lifecycle + detection** | **Done 2026-09-16.** E03, E07, E08, F12, F13, F14, E06, E11, F10. Procfile (production) deliberately ignored; only `Procfile.dev`. | G09 met: `test/scan-generate.test.ts` fixture matrix, `test/readiness.test.ts`, readiness and lifecycle on private tmux servers in `test/tmux-workspace.test.ts` and `test/lifecycle.test.ts`. |
| **M4: distribution** | **Done 2026-09-17** (v0.5.0). F21, F22, E12, E22, E23, E25, E26, B08/B09. | G10 met: native CI on linux-arm64, macos-arm64, macos-x64; release smoke per asset. |
| **M5: product** | E09, E10, E13, E15–E21, E24, E27, W14–W21. | Each item ships behind its own acceptance test. |

Rules carried over: fix shared boundaries, not callers. No prompts, editors, scans, or
network while holding the registry lock. Do not redefine `dependsOn`. Do not close a
finding on a happy-path test.

---

## 7. Verification commands

Run before every commit on the CLI repo:

```bash
bun run check
bun test
bun audit
bash -n install.sh scripts/build-release.sh
shellcheck install.sh scripts/build-release.sh   # when installed
bash scripts/build-release.sh --output dist/spinup && ./dist/spinup --version
grep -rniI --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  'runit' src test README.md CHANGELOG.md install.sh .spinup.yml bunfig.toml .github \
  | grep -viE 'legacy|RUNIT_SHIM_DIR|\.runit\.yml|renamed from|migrat'
```

The last command must print nothing once B01–B06 land.

Website:

```bash
cd ../runitfront && npm run build
grep -rniI --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next 'runit' . \
  | grep -v package-lock
```

Must print nothing after W01–W13 unless Q2 keeps the GitHub repo name.

---

## 8. Decisions (Q)

Resolved 2026-09-16.

| ID | Question | Decision |
|---|---|---|
| Q1 | Brand mark | **Change it.** Replace the "r" glyph with a new S mark, same circle and 20px stroke. One SVG for CLI favicon, site icon, OG image. |
| Q2 | Rename GitHub repos | **Done 2026-09-16.** `spinup` and `spinup-front`; installer, README and website URLs updated. |
| Q3 | Website terminal art | **Match the CLI.** Revert the uncommitted ASCII diff, keep Unicode box-drawing and `✓`, render the SPINUP glyph and `spinup my-app` exactly as the CLI prints them (W04, W09, W18). Fix Windows font fallback in CSS. |
| Q4 | npm publish | **Not yet.** `spinup` on npm is an unrelated package (created 2014, last published 2018, owner `jaz303`). `spinup-cli` and scoped names are free. See M6 §9.6. |
| Q5 | Docs location | **`docs/` in the CLI repo**, site consumes at build (W14). |
| Q6 | Domain | **Deferred.** W17 (OG/canonical) and the hosted schema URL (E17, W21) wait on it. Ship the schema in the release assets meanwhile and reference it by GitHub raw URL. |
| Q7 | Readiness | **Native** conditions (`port`, `http`, `exit`, `log`). No Process Compose dependency. |

---

## 9. M6 plan: remaining features

Written 2026-09-17, after v0.5.0. Every item in this section is **planned, not built**.
The order puts real-world validation first, because every feature so far was tested
only against fixture projects.

### 9.0 Order and releases

| Step | Items | Release | Why this position |
|---|---|---|---|
| 0 | A8 dogfood on 3–5 real projects, A10 one Mac install | patch releases as needed | Real repositories will expose detection and lifecycle gaps faster than any feature. Fixes found here outrank everything below. |
| 1 | E18 personal overrides, E15 runtime versions | **v0.7.0** | The two features that change daily and team use. Both touch config loading and `--check`, so they land together. |
| 2 | W19 accessibility, W20 color scheme | website, no CLI release | Independent of the CLI; small. |
| 3 | E24 Homebrew live (A15), AUR `spinup-bin` | **v0.7.x** | Channels, once there is a release worth distributing more widely. |
| 4 | E27 crash reports | v0.8.0, optional | Only valuable once people other than the author use it. |
| — | E19 config migrations | with the first format change | Build the mechanism when a `version: 2` exists, not before. The policy is defined now. |
| — | W17 SEO/sharing, W21 schema hosting | when Q6 (domain) is decided | Blocked. |

### 9.1 E18: personal overrides (`.spinup.local.yml`)

**Problem.** `.spinup.yml` is committed and shared. Today a developer who needs a
different port, an extra debug flag or one more service must edit the shared file and
avoid committing it.

**Design.**

- **File.** A git-ignored `.spinup.local.yml` next to the shared config. Its narrow
  schema is strict, like the main one:

  ```yaml
  # yaml-language-server: $schema=.../schema/spinup.local.schema.json
  default: dev-debug            # optional: personal default action
  env:                          # every service of every action
    LOG_LEVEL: debug
  actions:
    dev:
      services:
        api:                    # must name an existing service
          env: { PORT: "4001" }
          cmd: npm run dev -- --inspect
          ready: { port: 4001 }
      disable: [worker]         # leave these services out
      add:                      # extra services: tasks, or panes in a "local" window
        - name: storybook
          cwd: apps/web
          cmd: npm run storybook
  ```
- **What can be changed.** `cmd`, `cwd`, `env`, `ready` and `delay` per service.
  Services can be disabled or added. Structure beyond that (mode, windows, new actions)
  stays in the shared file, so the team's config remains the source of truth.
- **Merge order.** Shared config, then local overlay, then strict validation of the
  result. Validation also rejects a local reference to a missing service or action, a
  disabled service others depend on, and duplicate added names. Errors name the
  file: `.spinup.local.yml: actions.dev.services.apii does not exist`.
- **Environment precedence, highest first.** Local service `env`, shared service
  `env`, local top-level `env`, invoking shell, environment files.
- **Two loaders instead of one.**
  - `loadEffectiveConfig` is used by launch, `--plan`, `--graph`, `--env`,
    `--check`, `--doctor`, `--status`, `--restart`, completion and `--dry-run`.
  - `loadSharedConfig` is used by `--edit`, `--edit --interactive`, `--regenerate`,
    `--init` and `--relink`, which must never write local values into the shared file.

  Each call site is changed explicitly, and a test enumerates the commands so a new
  one cannot silently pick the wrong loader.
- **Visibility.**
  - `--plan` and `--graph` mark overridden values with `(local)`.
  - `--json` adds `overrides: ["actions.dev.services.api.env.PORT", ...]`.
  - `--doctor` lists the overlay and warns when git tracks `.spinup.local.yml` or
    does not ignore it (`git check-ignore`), because it may hold secrets.
- **Commands.**
  - `spinup <alias> --edit --local` opens the overlay, creating a commented template
    if it does not exist.
  - `--regenerate`'s preview warns when the overlay names services the new config
    no longer has.
- **Schema.** `schema/spinup.local.schema.json`, generated and drift-tested like the
  main one.

**Files.** `src/core/config.ts` (overlay schema, merge, two loaders),
`src/types/config.ts`, every command in `src/commands/`, `scripts/build-schema.ts`,
`docs/configuration.md`, and tests.

**Acceptance.**
- Overridden env, cmd, ready and delay reach both backends.
- Disable and add work in simple and tmux modes.
- Each validation error names the overlay path.
- A local-only secret never appears in `--plan`, `--json`, the shared file, or a
  regenerate preview.
- `--edit --interactive` on a project with an overlay leaves the shared file free of
  local values.
- `--doctor` warns for a tracked overlay.

**Risks.** Two sources of truth confuse people unless `--plan` shows provenance, so
provenance is part of acceptance, not a follow-up. A disabled service that is a
dependency must fail loudly, not start its dependents without it.

**Size.** About 2–3 days including tests.

### 9.2 E15: runtime version checks

**Problem.** A project declares Node 20 in `.nvmrc`, but the PATH has Node 22. Services
start and fail in confusing ways, or behave differently than for teammates.

**Design.**

- **Declarations read from each selected service's `cwd`, walking up to the project
  root.**

  | Tool | Sources, first found wins |
  |---|---|
  | node | `.nvmrc`, `.node-version`, `.tool-versions` (nodejs), `mise.toml` / `.mise.toml` `[tools] node`, `package.json` `engines.node` |
  | python | `.python-version`, `.tool-versions`, `mise.toml`, `pyproject.toml` `requires-python` |
  | go | `go.mod` `go` / `toolchain`, `.tool-versions` (golang), `mise.toml` |
  | ruby | `.ruby-version`, `.tool-versions`, `mise.toml`, `Gemfile` `ruby` |
  | java | `.tool-versions`, `mise.toml`, `.sdkmanrc` |
  | bun, deno | `.tool-versions`, `mise.toml`, `package.json` `engines.bun` |
  | rust | `rust-toolchain.toml` / `rust-toolchain` |

- **What is compared.** The version of the executable the service would actually
  run. It is probed with the launch environment's PATH and from the service's `cwd`,
  so mise, asdf and nvm shims resolve the way they will at launch. Probes run with a
  timeout, only for tools the selected action's commands need (reusing
  `inferRequiredTools`).
- **Matching.**
  - A version file with a partial version (`20`, `20.11`) matches as a prefix.
  - A range (`engines`, `requires-python`) uses `Bun.semver.satisfies`, so no new
    dependency is needed.
  - Aliases such as `lts/*`, `latest` and `system` are reported as "not checked",
    never as a mismatch.
- **Reporting.**
  - `--check` and `--doctor` add a runtimes section: tool, declared value and its
    source, found version, and result.
  - A mismatch is a problem (exit 2); an unparseable declaration is a note.
  - `--json` gains `runtimes`.
  - When a mise or asdf file declares the tool but it is missing, the hint is
    `mise install` or `asdf install`. Nothing is ever installed automatically.
- **Launch.** A one-line warning before starting, never a block, so a check that is
  wrong in an edge case cannot stop anyone working.

**Files.** New `src/core/runtimes.ts`; `src/commands/check.ts`, `doctor.ts`,
`run.ts` (launch warning); `docs/commands.md`; tests using fake `node`, `python3` and
`go` scripts on a temporary PATH.

**Acceptance.**
- `.nvmrc` `20` with Node 22 on PATH fails `--check` with both versions and the source
  file.
- `engines: ">=18"` with Node 22 passes.
- `lts/*` is not checked.
- A `.tool-versions` in a parent directory applies to a nested service.
- The probe runs in the service's directory, verified with a fake shim that prints
  different versions per directory.
- No probe for a tool the action does not use.

**Risks.**
- Version managers that hook the shell, such as nvm without shims, resolve
  differently in a non-interactive probe. This is documented as a known limit and
  reported as "not checked", not as a mismatch.
- Probe time adds up across many services, so probes are deduplicated by
  (tool, cwd-with-same-declaration).

**Size.** About 2 days.

### 9.3 E19: config migrations (policy now, code later)

**Policy.**
- `version` increases only for a change that makes an existing valid file invalid or
  changes its meaning.
- A new optional field does not bump it.
- Every bump ships with:
  - a migration that operates on the YAML document, so comments survive
  - a `docs/upgrading.md` entry
  - fixture files for the old version that must migrate and validate

**Mechanism, built with the first bump.**
- Loading an older file migrates it in memory and prints one note:
  `config is version 1; spinup --migrate-config updates the file`.
- `--migrate-config` shows the same structured preview as `--regenerate`, writes the
  private `.bak` file, and patches the document.
- A newer file than the binary understands keeps failing with the upgrade message, as
  it does today.

### 9.4 W19: website accessibility pass

- Keyboard:
  - a skip-to-content link
  - visible `:focus-visible` styles on nav links, copy buttons, pane selector buttons
    and the docs sidebar
  - no keyboard traps in the terminal scene
- Screen readers:
  - the terminal animation stays `aria-hidden`, with one static text summary instead
    of per-frame updates
  - copy buttons announce "copied" through a polite live region
  - tables keep header cells
  - the docs sidebar marks the current page (done)
- Motion:
  - `prefers-reduced-motion` stops the hero entry animation, section reveal and
    caret blink everywhere, not only in the terminal
- Contrast:
  - measure `--soft` text and 0.69rem pane titles against their backgrounds, and
    raise anything under 4.5:1 (3:1 for large text)
- Verification:
  - axe-core in headless Chrome against `/`, `/install`, `/changelog` and one docs
    page, with zero serious or critical violations
  - Lighthouse accessibility score of at least 95
  - a manual keyboard pass

**Size.** About 1 day.

### 9.5 W20: color scheme (decision needed)

**Recommendation: commit to dark.** The brand is a dark terminal aesthetic, and a light
palette doubles the visual QA for every component. Implementation:
- `color-scheme: dark` on `:root` and a `viewport.colorScheme` of `dark`, so form
  controls, scrollbars and the page before CSS loads match
- `theme-color` meta for mobile browser chrome

**Alternative.** A full light theme through token swaps under `prefers-color-scheme:
light`, about 1–2 days plus screenshot review of every page.

### 9.6 E24: package channels

| Channel | Status | What it takes | Recommendation |
|---|---|---|---|
| Install script | live | — | Primary channel. |
| Homebrew tap | ready, needs A15 | Create `PedroElizalde01/homebrew-spinup`, add `HOMEBREW_TAP_TOKEN`; the release job commits the formula. | Do it now; zero ongoing work. |
| AUR `spinup-bin` | not started; name free | An AUR account with SSH key (user action), a PKGBUILD with x86_64 and aarch64 sources and checksums from SHA256SUMS, and a release job pushing to the AUR git repo with an `AUR_SSH_KEY` secret. | Do after Homebrew; about half a day once the account exists. |
| mise / ubi | likely works today | `mise use -g github:PedroElizalde01/spinup` picks release assets by OS and architecture. | Test once and document if it works; no code. |
| npm | blocked on name | `spinup` belongs to an unrelated package (last published 2018). Either request a transfer through npm's name dispute process, or publish scoped (for example `@pedroelizalde01/spinup`) using per-platform optional dependency packages plus a small launcher, like esbuild and biome. That means 7 packages per release and an `NPM_TOKEN`. | Keep deferred (Q4). Revisit only if users ask for `npx`. |

### 9.7 E27: local crash reports (optional)

- Only unexpected errors count as crashes: `TypeError`, `RangeError`,
  `ReferenceError`, and anything thrown outside spinup's own error messages. User
  errors keep today's one-line messages.
- **On a crash, by default:** print one line saying it looks like a bug, with the
  issue URL. Nothing is written to disk.
- **With `SPINUP_CRASH_REPORT=1`:** also write
  `$XDG_STATE_HOME/spinup/crash/<timestamp>.json` with:
  - version, platform and architecture, Bun version
  - the command's flag names, but no values, aliases or paths
  - the stack trace, with the home directory replaced by `~`

  Never environment variables, config contents or project paths.
- Spinup never makes a network call for this. The user attaches the file to an issue.

**Size.** About half a day.

### 9.8 Blocked on the domain (Q6)

- **W17.** `metadataBase`, OpenGraph and Twitter cards, an OG image generated with the
  wordmark, `robots.ts`, `sitemap.ts` and canonical URLs.
- **W21.** Serve `schema/*.json` from the domain under a versioned, immutable path,
  and switch the modeline URL. Keep the GitHub raw URL working, because existing files
  reference it.

### 9.9 Open questions for M6

| ID | Question | Recommendation |
|---|---|---|
| Q8 | Dark-only website, or add a light theme? | Dark-only, made explicit (W20). |
| Q9 | May `.spinup.local.yml` add services, or only override existing ones? | Allow add and disable; people commonly want an extra local-only service (storybook, a tunnel). |
| Q10 | Should a runtime version mismatch fail `--check` (exit 2) or only warn? | Fail `--check` and `--doctor`, warn on launch. |
| Q11 | npm: dispute the `spinup` name, publish scoped, or skip? | Skip for now. |
