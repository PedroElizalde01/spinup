# RUNIT: codebase review, research, and improvement plan

Reviewed on **2026-09-06**, against commit `c5389074a0b3a42d7ace4ed0f00f9c986675af70`, version **0.2.2**.

## 1. Recommendations

| Decision | Recommendation | Reason |
|---|---|---|
| D1 | **Keep TypeScript and Bun. Do not rewrite now.** | The immediate failures are execution, ownership, and configuration bugs. Another language would not fix their semantics. |
| D2 | **Make launches safe and predictable before adding more detectors.** | Prioritize F01–F08 and F20. A launcher must not overwrite unrelated files, destroy unrelated sessions, expose secrets, or silently change commands. |
| D3 | **Let Docker Compose own container orchestration.** | RUNIT should launch and inspect Compose, not implement a partial competing model of it. See F14. |
| D4 | **Evaluate Process Compose only if RUNIT needs substantial supervision.** | It already provides readiness, recovery, process control, and logs. Start by invoking an existing project configuration, not by building a plugin framework. |
| D5 | **Concentrate the product on project discovery, explicit configuration, and launching from anywhere.** | These are useful together. Competing with every task runner, toolchain manager, and supervisor would spread the maintenance effort too thin. |
| D6 | **Resolve naming and licensing before wider distribution.** | The established UNIX `runit` project creates real naming confusion. The repository also has no explicit license. See F23. |

The highest-value next release is a **reliability release**, not a technology migration or a larger terminal interface.

## 2. Scope and evidence

### What was reviewed

Read all tracked project-owned text files: all **32 files under `src/`**, all tests, `README.md`, package and lock files, `.runit.yml`, TypeScript/Bun configuration, installer, build script, and release workflow. There are **48 tracked files** and **3,103 lines under `src/`**, including declarations.

The favicon SVG was read. Binary icons and ignored compiled artifacts were inventoried rather than treated as source. Relevant installed Execa implementation/types were inspected, but this was not a line-by-line audit of every transitive dependency.

This revision incorporates useful proposals from the other agent's `REVIEW.md`, including local execution without registration, existing project launch definitions, native tmux controls, and optional logs. That document remains unchanged. Findings marked reproduced rely on this review's own probes, not the other report's verification labels.

### Checks performed

| Check | Result |
|---|---|
| `bun run check` | Passed. |
| `bun test` | **6 passed**, 0 failed, 15 assertions across 3 test files. |
| `bash -n install.sh scripts/build-release.sh` | Passed. ShellCheck was not installed. |
| Fresh Linux baseline build using `scripts/build-release.sh` | Passed. The resulting executable ran `--help`. |
| `bun audit` | **4 advisories: 2 high, 2 moderate**, affecting the two direct YAML dependencies. See F20. |
| Isolated execution probes | Reproduced alias, shell-command, configuration, environment, diagnostics, registry, process-lifecycle, and tmux failures described below. |
| Compose configuration resolution | Compared RUNIT's selection with Docker Compose's actual selection without starting containers. |
| Follow-up build checks | Measured minification and tested the suggested bytecode build against Bun 1.3.9. Results are in section 4.3. |
| Follow-up compatibility probes | Checked source/compiled symlink identity and demonstrated that a default YAML-parser substitution loses inherited Compose dependencies. See F01 and F20. |
| External research | Consulted upstream documentation, dependency source, and GitHub security advisories. References are in section 9. |

Execution environment: Linux x64, Bun **1.3.9**, Node **22.14.0**, tmux **3.2a**, Docker Compose **2.34.0**.

Probes used temporary project directories and isolated `HOME` values. Real tmux probes used a dedicated socket and configuration, then removed that test server. Secret-handling tests used a dummy value. No real project services or containers were started, and no application source or dependency versions were changed.

### Confidence and limitations

**Reproduced** means exercised against this checkout or its freshly compiled binary. Two private helpers were exercised from temporary source copies: interactive editing used a save-only prompt stub, and regeneration exported its existing comparison function. Those were not full interactive-terminal tests.

**Source-confirmed** means the behavior follows directly from the implementation but the specific scenario was not executed. **Research-backed** means supported by the linked upstream material, not benchmarked as a replacement for RUNIT.

This review did not execute macOS or Windows binaries, perform a cross-platform benchmark, validate a public release download, or test a live database startup. Recommendations involving third-party supervisors require a proof of concept before adoption. Documentation fetched from moving branches describes its state on the review date, not necessarily the behavior of older installed versions.

## 3. Findings

Priority definitions:

- **P0:** Address before actively promoting another release. These include local safety problems and changes that silently break user intent.
- **P1:** Address in the reliability work immediately after P0.
- **P2:** Useful improvements after the core workflow is dependable.

Severity describes impact on RUNIT users, not a claim of remotely exploitable server vulnerabilities. RUNIT intentionally executes trusted project commands with the user's privileges. A malicious `cmd` in a configuration is not, by itself, a new command-injection vulnerability. Alias identifiers, file ownership, and accidental secret disclosure are separate problems.

### F01. Alias handling permits file traversal, command substitution, and executable replacement

**High · P0 · Reproduced**  
Locations: `src/core/registry.ts:9–23,63–79`, `src/core/shim.ts:6–21`, `src/commands/run.ts:164–188`.

`validateAlias()` rejects only an empty normalized string and the reserved name `runit`. The original value is then used as a registry key, path component, and interpolated Bash string. In an isolated home directory:

- `../review-victim` created a file outside the shim directory.
- An alias containing `$(touch REVIEW_ALIAS_MARKER)` executed that harmless substitution when its shim ran.
- An existing executable at the shim path was overwritten without an ownership check.
- Looking up unregistered `toString` returned a function inherited from `Object.prototype`. Registering `__proto__` did not persist an own entry.

Removal also derives a path from the raw alias. Ordinary aliases can shadow commands elsewhere on `PATH`. Validation lowercases only for checking, so case-sensitive registry entries can disagree with case-insensitive macOS filesystems.

**Fix:** Establish one canonical alias format at every public boundary. A conservative format such as lowercase letters, digits, `_`, and `-`, starting with a letter or digit, avoids shell and tmux punctuation. Use own-key registry lookup. Reject non-RUNIT destination files and symlinks, check command-name collisions, and refresh/remove only demonstrably owned shims. Validate containment in the shim helper as well as at registration. Keep safely quoted wrappers. A follow-up probe confirmed that source-mode `process.execPath` points to Bun, while a compiled symlink invocation puts a virtual bundle path in `process.argv[1]`, not the alias. Replacing wrappers with symlinks and dispatching on those values is not a working drop-in solution.

**Acceptance:** Invalid aliases cannot write or remove anything outside the test shim directory. Existing user executables and symlink targets remain unchanged. Prototype names never resolve to inherited values.

### F02. Starting a project destroys an existing tmux session, including prefix matches

**High · P0 · Reproduced**  
Locations: `src/tmux/runner.ts:111–115`, `src/tmux/session.ts:34–56`.

The launcher checks for a session using the bare alias and then kills it. tmux resolves targets by exact name, name prefix, and pattern unless explicitly constrained [S04]. A test session named `unrelated-long` was killed when launching alias `unrelated`. Even an exact-name session is destroyed regardless of ownership or whether the user only wanted to reconnect.

**Fix:** Use exact targeting and stable session IDs, record RUNIT ownership, and attach to an existing owned session by default. Restart must be explicit. Never replace an unrelated session. Consider a RUNIT-specific socket only if session isolation is an intended behavior, not as a substitute for ownership checks.

**Acceptance:** Repeated launch preserves the existing session and processes. A longer-name or unrelated exact-name session is never killed.

### F03. tmux launch exposes environment secrets as terminal text

**High · P0 · Reproduced**  
Locations: `src/tmux/runner.ts:31–32,76–88`.

The launcher constructs `export KEY='value'` statements and types them into an interactive shell with `send-keys`. `tmux capture-pane` recovered the dummy secret in the launch command. Masking `--env` output does not protect this separate path. Shell-history persistence depends on shell configuration and was not asserted.

**Fix:** Use `new-session`, `new-window`, and `split-window` with `-c` for cwd, `-e KEY=value` for environment, and `-P -F '#{pane_id}'` to capture stable pane IDs. Capture session/window IDs as needed instead of manufacturing index targets. Declare and check the minimum tmux version supporting the selected options before creating a workspace [S04]. A single command string still runs through a shell. Separate command/argument values support direct execution, so preserve F07's explicit command contract rather than claiming this removes every shell. Keep sensitive values out of status output, debug command echoes, and recorded plans.

Passing values with tmux environment options removes this terminal disclosure, but it is **not** a secret vault. Command arguments may be briefly inspectable by same-user processes, and process environments remain accessible under normal OS permissions. If that stronger threat model matters, evaluate a private environment handoff rather than promising total secrecy.

**Acceptance:** A known dummy secret never appears in pane capture or RUNIT diagnostic output.

### F04. The compiled binary loads `.env` from the directory it was invoked in

**High · P0 · Reproduced**  
Locations: `scripts/build-release.sh:115–121`, `src/core/env.ts:24–49`, `src/core/executor.ts:105–113`.

Bun's compiled executables autoload local dotenv and Bun configuration by default [S01]. Running the compiled RUNIT from project B while starting registered project A passed B's dummy dotenv variable to A. RUNIT's explicit loader then merges on top of an already contaminated environment. `--env` lists only variables from its explicit target-project files, so it does not explain the whole effective environment.

This directly undermines the promise of launching a project “from anywhere.” It can select unintended endpoints or credentials without changing the target project's configuration.

**Fix:** Build with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`, both available in the installed Bun 1.3.9. Let RUNIT deliberately resolve the target project's files. Give source-mode development and tests an equivalent explicit environment policy.

**Acceptance:** Starting A from B produces the same environment as starting A from a neutral directory, apart from intentionally inherited shell variables.

### F05. Editing can discard valid configuration without editing those fields

**High · P0 · Reproduced**  
Locations: `src/core/interactive.ts:19–32,47–82,131–143`, `src/commands/edit.ts:78–80,96–106`.

The interactive editor extracts only `name`, `cwd`, and `cmd`, then rebuilds tasks/panes. A save-only probe discarded `env`, `delay`, and `dependsOn`. The tmux path also reconstructs the primary window with a generated name/layout instead of preserving its metadata.

The normal editor path parses and reserializes the file after the editor exits. A no-op editor removed a user comment. It can also normalize formatting and discard schema-stripped fields.

**Fix:** Preserve the original objects and update only selected fields. Normal editor mode should validate and warn, not rewrite a valid user file merely because serialization differs. If structured editing is retained, the already-installed `yaml` Document API supports comment-aware changes [S09]. Handle references deliberately when deleting services.

External-editor invocation also treats `$EDITOR` as one executable name. A probe with `EDITOR='true --version'` failed with ENOENT, illustrating why normal values such as `code --wait` fail. Support editor arguments with correct quoting rather than splitting blindly on spaces.

**Acceptance:** Saving without changes leaves all values intact. Opening and closing the external editor without changes leaves file bytes intact. Changing one command preserves unrelated metadata and comments. Editor commands with arguments work.

### F06. Regeneration compares sets of lines rather than configuration changes

**Medium · P0 · Reproduced**  
Locations: `src/commands/run.ts:97–145,164–175`.

The preview discards indentation, order, and duplicate lines. Swapping commands between two services produced `[]`, after which regeneration would report no changes and return. This is not merely an unattractive diff. It can prevent a real change from being applied.

A first registration with `--regenerate` also replaced an existing configuration without the preview used for an already registered alias. Regeneration is explicitly an overwrite operation today, not a merge of hand-maintained settings, but that distinction deserves a consistent preview.

**Fix:** Compare complete content for equality. Show a real textual diff or an action/service-level change summary. Apply the same preview rules whether or not the alias is registered. Explicitly warn about removed custom actions and preserve a recoverable original before replacement. No general-purpose merge engine is needed.

**Acceptance:** Reordering, duplicate-line changes, and command ownership changes are detected. Both registration paths follow the same confirmation policy.

### F07. Prefixing arbitrary commands with `exec` changes their meaning

**High · P0 · Reproduced**  
Locations: `src/core/executor.ts:105–111`, `src/tmux/runner.ts:87`.

`printf FIRST && printf SECOND` printed only `FIRST`. `REVIEW_VAR=value printenv REVIEW_VAR` failed because the shell attempted to execute `REVIEW_VAR=value` as a program. The implementation prepends `exec` to a whole shell expression. Replacing the shell during the first command means subsequent shell statements may never execute.

**Fix:** Define a consistent command contract. Execute trusted shell strings as complete shell programs without blindly prefixing them. Use explicit argv execution for internally generated commands where practical. Preserve process-group handling separately rather than trying to achieve it through a textual `exec` prefix. Execa already supports an explicit shell [S03].

**Acceptance:** Compound commands, inline environment assignments, pipelines, multiline commands, and quoted paths behave consistently in simple and tmux modes.

### F08. Failed services do not stop siblings, and cancellation leaves descendants

**High · P0 · Reproduced**  
Locations: `src/core/executor.ts:56–80,120–160`.

A `false` task alongside `sleep 20` left the launcher waiting until the isolated test timed out. `Promise.allSettled()` waits for every service, and failures never abort siblings. With real long-running servers, the final error may never surface.

A separate task spawned a grandchild process. Sending SIGTERM to RUNIT allowed the launcher to exit while the grandchild remained alive. Execa cancellation and `cleanup: true` must not be mistaken for complete process-tree ownership [S02, S27]. The code also assigns exit code 130 for either SIGINT or SIGTERM and wraps child failures without preserving their exit status at the CLI boundary.

**Fix:** Define fail-fast behavior for required services, retain the originating failure, and cancel siblings immediately. On supported POSIX systems, establish owned process groups and terminate those groups with a bounded grace period. Do not signal RUNIT's own foreground group or unrelated processes. Distinguish one-shot completion from unexpected service exit. Keep meaningful exit statuses and a concise underlying failure reason.

**Acceptance:** A startup failure returns promptly and leaves no owned descendants. SIGINT and SIGTERM release test ports and terminate an npm/shell/child chain, not just its immediate parent.

### F09. Simple mode buffers long-running logs and does not forward stdin

**High for long sessions · P1 · Reproduced**  
Locations: `src/core/executor.ts:18–39,105–118`.

Execa buffers output by default even while `.all` is streamed. A controlled emitter exceeded **100,000,000 characters** and failed with `isMaxBuffer: true`. The prefixer also keeps an arbitrarily long unterminated line and ignores output backpressure. Chunk-wise `toString()` can split multibyte characters.

A child waiting for piped input received zero bytes. Execa's default stdin is a pipe, but RUNIT never connects the user's stdin. stdout and stderr are both emitted onto RUNIT's stdout, reducing usefulness in scripts.

**Fix:** Set `buffer: false` for continuously streamed services and use bounded, backpressure-aware line handling. For a single interactive task, inherited stdio is the simplest correct behavior. For multiple tasks, make the input recipient explicit or use tmux, rather than broadcasting input. Preserve stderr when machine-readable output matters. These facilities already exist in Execa and Node streams [S02].

**Acceptance:** A log stream larger than the previous limit completes without output-related termination or continually growing retained buffers. Single-task stdin works, and Unicode split across chunks is preserved.

### F10. Dependency ordering is not readiness or successful completion

**High · P1 · Reproduced**  
Locations: `src/core/dependencies.ts:9–52`, `src/core/executor.ts:96–142`, `src/tmux/runner.ts:70–92`, `src/core/detectors/docker.ts:23`.

A preparation task scheduled a file write after 300 ms. Its dependent immediately checked for the file and failed. Topological sorting determines launch order only. A fixed delay pauses all later launches, including unrelated services, without proving a database or API is ready.

**Fix:** First document the existing meaning of `dependsOn`. Before changing it, distinguish **started**, **ready**, and **completed successfully**. Support a bounded readiness probe where necessary, or delegate supervision to Process Compose. Prefer application health checks over an open TCP port when correctness depends on initialization. Delegate container health semantics to Compose [S05, S10].

**Acceptance:** A dependent waits for the declared condition. A timeout identifies the blocking dependency. A failed setup job prevents dependents from starting, while independent services are not serialized by unrelated delays.

### F11. tmux creation assumes user settings and terminal capacity

**Medium · P1 · Reproduced and source-confirmed**  
Locations: `src/tmux/layout.ts:22–52`, `src/tmux/runner.ts:35–44,115–125`, `src/tmux/session.ts:59–66`.

With `base-index 1`, startup failed at `rename-window ... :0`. An eight-pane tiled workspace failed with `no space for new pane` because the code repeatedly splits before applying the final layout. Targets are manufactured from zero-based indexes rather than returned object IDs.

Source review also found no cleanup of a partially constructed workspace and no branch to switch clients when already inside tmux. Commands are typed into a user-configured interactive shell, making execution dependent on that shell's startup and syntax. Nested interactive attachment was not reproduced in this noninteractive harness.

**Fix:** Capture session/window/pane IDs with tmux's native creation output. Start commands directly, pass cwd separately, and select a layout as panes are added. Detect when the display is too small and offer a deliberate window layout instead of leaving a broken session. Remove only the newly created owned session on setup failure. When launched from an attached tmux client, use `switch-client` to select the owned target session rather than nesting an `attach-session`. Outside tmux, attach normally. In noninteractive contexts, return the session identity and attach instructions without attempting either interactive operation.

**Acceptance:** Test zero/one-based settings, multiple windows, eight services, a constrained terminal, and launch from inside tmux. Do not “fix” compatibility by rewriting the user's global tmux settings.

### F12. Detection ignores explicit project structure and invents runnable fallbacks

**High · P1 · Reproduced**  
Locations: `src/core/scanner.ts:101–145,147–232`, `src/core/detectors/node.ts:121–198`, `src/core/detectors/python.ts:12–68`, `src/core/detector.ts:25–31,81–98`.

The fixture matrix exposed these cases:

| Fixture | Observed result |
|---|---|
| Valid root `dev` script plus `packages/util` without a runnable script | Root command was ignored and detection fell back to `npm start`. |
| `workspaces: ["components/*"]` | The runnable workspace was not discovered. |
| Python service under `services/api` | The service was missed and generated output used `npm start`. |
| `packageManager: "pnpm@10.0.0"` without a lockfile | Generated npm commands. |
| Empty directory | Generated a Node `npm start` task despite reporting an unknown stack. |

Workspace declarations only set a boolean. Candidate scanning is hardcoded to immediate `apps`, `services`, and `packages` children. Root scripts are discarded on the monorepo branch. Node detection can select finite `check` or `test` scripts as a development environment. Python uses substring matches and guesses entrypoints without checking the project environment.

**Fix:** Prefer explicit configuration and existing root launch scripts. Honor workspace patterns and exclusions [S15, S16]. Respect declared package managers and report conflicting lockfiles instead of silently choosing one. Apply runtime inspection to discovered service directories. For Python, recognize existing uv/Poetry/venv arrangements and verify entrypoints rather than guessing from dependency names [S14]. An unknown project should request a command or produce an explicitly incomplete configuration, not silently assume Node.

**Acceptance:** Add the fixture matrix above. Every generated command should have an inspectable origin, such as `package.json scripts.dev`, rather than a hidden heuristic.

### F13. Detected service names collide across runtimes and directories

**High · P1 · Reproduced**  
Locations: `src/core/detectors/node.ts:159–163,211–216`, `src/core/detectors/python.ts:23–25,39–41`, `src/core/detector.ts:34–66`, `src/core/generator.ts:38–58`.

A root Node app and root FastAPI app both become `app`, making the generated config fail its own duplicate-name validation. A Compose service named `app` plus a root Node app does the same and also creates an inferred self-dependency. Equal directory basenames under different workspace roots can collide too.

**Fix:** Assign deterministic unique service identities before dependency inference. Preserve simple names when unambiguous and disambiguate only collisions using runtime or relative path. Keep display names separate only if the interface genuinely needs that distinction. Validate the generated result before persisting or registering anything.

**Acceptance:** Node/Python, Node/Compose, and duplicate workspace-basename fixtures generate valid configs with correct dependency references.

### F14. Compose detection and execution describe different applications

**High · P1 · Reproduced and research-backed**  
Locations: `src/core/scanner.ts:135–145`, `src/docker/compose.ts:17–39`, `src/core/detectors/docker.ts:16–24`, `src/core/generator.ts:65–73`.

When `compose.yaml` and `docker-compose.yml` both existed, RUNIT selected the latter while actual Compose selected `compose.yaml`. Generated commands do not pass the detected file with `-f`.

The raw parser also ignores override merging, includes, active profiles, and dependency conditions. Every Compose service becomes a separate `docker compose up SERVICE` process in mixed projects. Each invocation can start dependencies independently, creating overlapping lifecycle ownership. Explicitly targeting profiled services enables them even when the user did not activate their profile [S07]. The parser's treatment of all profiles as services can therefore launch optional tools or jobs unintentionally.

**Fix:** Prefer one authoritative Compose invocation. When Docker is available, use `docker compose config --format json` or `--services` for effective configuration and keep the exact file/profile selection consistent with execution [S06]. Avoid printing resolved secrets. If Docker is unavailable, report limited static detection rather than pretending to fully interpret Compose.

For native services that need containers first, `docker compose up --wait --wait-timeout ...` is worth evaluating. It implies detached mode and waits for running/healthy state [S08]. Services without healthchecks are not thereby application-ready. Detached startup also requires an explicit decision about which resources RUNIT owns and should stop. Do not add `down -v` as an automatic cleanup step.

**Acceptance:** Detection and execution select identical files and profiles. Optional services stay optional. One component owns container startup and shutdown.

### F15. Explicit environment loading has surprising precedence and global effects

**Medium · P1 · Reproduced and source-confirmed**  
Location: `src/core/env.ts:24–49`.

The loader always reads `.env.development`, even for a `build` action. It places that file after `.env.local`, then loads `.env.<action>`. There is no single universal dotenv convention, but this policy is undocumented and mixes action names with deployment modes.

It also overwrites existing shell values with file values and mutates `process.env`. A shell sentinel became the file value in the probe. The returned `mergedEnv` is not used by current callers. Files are resolved at the registered project root rather than explicitly following `config.root` or per-service cwd.

**Fix:** Choose and document an environment policy instead of inferring an environment from every action name. Keep parsing pure and pass the selected effective environment explicitly to both backends. A reasonable default is per-task explicit values over inherited shell values over selected dotenv files, with any alternative precedence deliberately configured. Resolve file paths predictably and show key origins, never secret values. `dotenv.parse` remains useful for this controlled behavior [S17].

**Acceptance:** Loading for display does not mutate global state. Shell override, per-service override, `config.root`, missing files, and action/mode selection have explicit tests.

### F16. Diagnostics return success for environments that cannot run

**Medium · P1 · Reproduced and source-confirmed**  
Locations: `src/commands/check.ts:34–57`, `src/commands/doctor.ts:174–213`, `src/core/health.ts:20–28,92–154`.

`--check` returned zero with a nonexistent task cwd. `--doctor` printed `ready` while required tmux was unavailable because its final status considers path warnings, not required-tool failures.

Tool inference also uses the detected project rather than only the selected action. It can require Node for a Bun-only command, check `python` when only `python3` is appropriate, miss a command-specific package manager, and accept a file path as a cwd because `access()` does not verify that it is a directory. `docker -v` proves neither Compose availability nor daemon connectivity.

**Fix:** Separate required failures, optional tools, and informational detection. Base readiness and exit status on the same structured result. Check the selected execution plan, verify directories, add bounded tool timeouts, and distinguish Docker CLI, Compose plugin, and daemon checks. Do not force a daemon check for an action that does not need one.

**Acceptance:** A missing required tool, invalid cwd, or dependency cycle produces nonzero status. Optional Docker/tmux absence does not make a simple unrelated action fail.

### F17. Configuration validation silently drops unknown fields and misses semantic errors

**Medium · P1 · Reproduced and source-confirmed**  
Locations: `src/core/config.ts:9–105,130–138`, `src/core/dependencies.ts:14–20,55–66`.

Zod objects strip unknown keys by default here. A `readiness` field was accepted and discarded. Cyclic dependencies pass `parseConfig()`, although execution later rejects them. Simple actions can have no tasks, strings containing only whitespace satisfy `min(1)`, environment names are unrestricted, and tmux duplicate-name diagnostics use flattened indexes that do not identify actual pane paths.

The graph view is also not a graph: two independent services are printed as `a ↓ b`. A branching DAG becomes a false chain. The plan lists configuration order rather than resolved dependency order and omits delays/dependencies.

**Fix:** Validate accepted configuration fields strictly, check semantic graphs during validation, and report real window/pane locations. Validate shell environment names where exporting is supported. Render actual dependency edges, such as `web depends on api, db`, or explicitly label output as an ordered list. Show the resolved plan with cwd, conditions, and environment key origins.

**Acceptance:** Typos fail rather than disappear. Cycles fail before side effects. Independent nodes have no invented edge. Plan order matches execution order.

### F18. The CLI cannot select generated actions or identify its own version

**Medium · P1 · Reproduced and source-confirmed**  
Locations: `src/cli.ts:28–111`, `src/core/shim.ts:13`, `src/commands/run.ts:343–363`, `src/core/generator.ts:65–91`.

The generator emits `docker`, `prisma-generate`, and `prisma-migrate`, but every public start selects `config.default`. They cannot be selected without editing the default. `executeAction()` already accepts an action name, so the execution mechanism is mostly present.

`--version` is unknown. Shim-forwarded management flags conflict with its unconditional hidden `--start`: the equivalent of `my-app --doctor` fails the primary-action check. Users also lack a documented argument-passthrough contract.

**Fix:** Add an explicit action selector, make starting discoverable, list available actions, and thread selection through plan/graph/env/check. Preserve current registration behavior during that change rather than silently repurposing existing invocations. Embed the package version and commit in the build. Define which shim arguments select RUNIT operations and which, if any, reach a task. Reject unsupported excess input clearly.

**Acceptance:** A generated non-default action runs without rewriting config. Source and compiled binaries report the same version. Every documented shim argument works or gives a precise validation error.

### F19. Registry updates lose concurrent registrations, and persistence is not atomic

**Medium · P1 · Reproduced and source-confirmed**  
Locations: `src/core/registry.ts:58–74`, `src/core/config.ts:163–165`, `src/core/shim.ts:10–21`, `src/commands/run.ts:149–161`, `src/commands/remove.ts:11–12`, `src/utils/paths.ts:16–25`.

Twenty concurrent registrations left **one** of those entries. The registry performs an unlocked read-modify-write. Direct file writes can also leave a truncated registry/config after interruption. Registration writes the registry before creating the shim, and removal deletes the registry entry before deleting the shim, so failures can leave inconsistent state.

The registry ignores `XDG_CONFIG_HOME`. The installer supports a custom binary directory while shims always go to `~/.local/bin`, which can make their installation instructions misleading.

**Fix:** Use unique temporary files in the destination directory and atomic replacement for file integrity. **Atomic rename alone does not prevent lost updates.** Serialize the complete registry transaction with a small cross-process lock or choose a per-alias storage scheme. Preflight ownership/permissions before registration, and make interrupted operations recoverable. Honor the XDG override while retaining the current default and migration behavior [S18].

SQLite is not required merely to store alias-to-path mappings. Consider it only if actual concurrent state and lifecycle history justify transactions beyond this small registry.

**Acceptance:** Parallel registrations survive. Interrupted writes leave a valid old or new file. Failed shim creation does not leave a success-looking registration. Removal never deletes an unowned file.

### F20. Both locked YAML parsers have published vulnerabilities

**High/Moderate upstream severity · P0 · Verified dependency audit and advisory lookup**  
Locations: `bun.lock`, `src/core/config.ts:4,130–132`, `src/docker/compose.ts:1,29–31`.

| Dependency in lockfile | Advisory | Upstream severity | First patched version reported by advisory metadata |
|---|---|---|---|
| `yaml@2.8.2` | GHSA-48c2-rrv3-qjmp: deeply nested collections can overflow the call stack | Moderate | `2.8.3` on the 2.x line |
| `js-yaml@4.1.1` | GHSA-h67p-54hq-rp68: repeated aliases in merge keys cause excessive CPU work | Moderate | `4.2.0` on the 4.x line |
| `js-yaml@4.1.1` | GHSA-52cp-r559-cp3m: merge-key chains cause quadratic CPU work | High | `4.3.0` on the 4.x line |
| `js-yaml@4.1.1` | GHSA-5p4m-2wfm-xmqj: ordered-map resolution causes quadratic CPU work | High | `4.3.1` on the 4.x line |

These advisories were published after the reviewed March release. RUNIT parses project-controlled files, including during inspection, so parser resource exhaustion matters even without starting commands. This is a local availability risk, not evidence of remote code execution or exploitation of this repository. Large attack payloads were not executed during the review.

**Fix:** Update and re-audit. At the review date, retaining both parsers requires at least the relevant patched versions above. Better, remove the duplicate Compose parser dependency and use the updated `yaml` package where static YAML parsing remains necessary. Preserve Compose anchor/merge semantics deliberately, such as `merge: true` where appropriate, and test the change. A follow-up fixture confirmed that `js-yaml` preserved `depends_on` inherited through `<<`, default `yaml.parse` did not, and `yaml.parse` with `merge: true` did. Replacing imports blindly is not a compatibility guarantee. Canonical Compose inspection may remove most of that parser's purpose entirely.

**Acceptance:** Audit no longer flags these locked versions, malformed input fails within bounded resources, and anchor/merge fixtures continue to work. Sources: S29–S32.

### F21. Releases have no test gate or target-platform execution evidence

**High operational risk · P1 · Source-confirmed**  
Location: `.github/workflows/release.yml:1–63`.

The only workflow builds on tags/manual dispatch. It runs neither `bun run check` nor `bun test`, and there is no push/PR test workflow. All three binaries are cross-compiled on Ubuntu, with no execution on macOS. The Bun version is not pinned. Third-party actions use mutable version tags, and `contents: write` applies to build jobs as well as publishing.

The six existing tests mostly exercise pure parsing/detection. They do not cover the filesystem-writing, process, tmux, editor, or CLI paths behind the findings above. `tsconfig.json` also excludes tests from type checking.

**Fix:** Gate PRs and releases on the existing typecheck/test commands, then add small regression tests for confirmed failures. Pin the build runtime and action revisions, use read-only build permissions, and grant publishing permission only where required [S20]. Smoke-test binaries on their actual supported operating systems, including a harmless launch rather than only `--help`. Include the tests in an appropriate typechecking setup without adding a second test framework.

**Acceptance:** A failing regression cannot publish a release. Linux and both supported macOS architectures have execution evidence, and reports identify the exact runtime and commit used to build them.

### F22. Installer integrity and platform handling need clearer guarantees

**Medium · P1 · Source-confirmed**  
Locations: `install.sh:25–35,79–106`, `scripts/build-release.sh:72–100`, `.github/workflows/release.yml:18–25`.

The installer uses HTTPS and `curl -f`, which already provide transport protection and HTTP failure detection. However, it verifies no published digest or provenance before installation. It stages in the system temporary directory and moves to the installation directory, which is not guaranteed to be an atomic rename when filesystems differ.

It recognizes Linux arm64, but releases only publish Linux x64 and two macOS variants. That supported-looking combination therefore resolves to a missing asset. There is no libc check for Alpine/musl, and option arguments such as an empty `--bin-dir` are not validated carefully. Successful Windows cross-compilation would not make the Bash/tmux workflow Windows-compatible.

**Fix:** Publish SHA-256 checksums and verify before replacing the existing executable. Stage the final replacement in the destination filesystem. Add attestations or signed provenance for stronger build identity [S21]. A checksum downloaded from the same compromised release source is not an independent authenticity guarantee. Explicitly reject unsupported OS/architecture/libc combinations or publish and test them. Validate options before downloads and preserve a working installation on failure.

For macOS distribution, test the actual installation and Gatekeeper experience. Signing/notarization should follow the chosen distribution channel rather than an assumption that cross-compilation is sufficient [S01].

**Acceptance:** A wrong digest, missing asset, invalid option, or interrupted update leaves the old executable intact and returns a clear nonzero failure.

### F23. Documentation and packaging do not yet define a dependable public contract

**Medium · P2 · Source-confirmed and research-backed**  
Locations: `README.md:26–40,112–124,407–439`, `package.json:4`, repository file inventory.

The README has many terminal-output examples but only a minimal simple-mode config. It does not explain tmux configuration, dependency semantics, delay units, environment precedence, shell behavior, signal handling, config trust, or regeneration's effect on custom actions. The package describes the tool as “Production-grade” despite the missing operational safeguards above.

The established UNIX supervisor named `runit` is documented at smarden.org [S24]. That creates command/search/package confusion, but it does **not** make every distribution strategy impossible. A scoped npm package or namespaced Homebrew tap remains a separate possibility. Do not pick another name without checking actual availability.

No explicit `LICENSE` file or package license field is present. Choose and publish a license before encouraging third-party redistribution. GitHub visibility should not substitute for that decision.

**Fix:** Document the real execution contract, provide working mixed/monorepo examples, publish minimum supported tool versions, and distinguish known limitations from supported behavior. Address licensing and decide whether a distinct executable name is worthwhile before the user base grows. Do not delay correctness work for a branding exercise.

## 4. Technology assessment

### 4.1 Runtime and language

| Option | Useful advantages | Costs and limitations for RUNIT | Recommendation |
|---|---|---|---|
| **Current TypeScript + Bun** | Existing implementation, fast development feedback, built-in tests, straightforward standalone compilation. | Large embedded runtime, runtime-specific behavior such as autoloaded configuration, cross-platform behavior still needs testing. | **Keep.** Pin and maintain Bun, disable unwanted autoloading, fix execution semantics, and measure optimizations. [S01] |
| **Node.js LTS + TypeScript** | Familiar runtime support and straightforward npm distribution to teams already using Node. | Requires a runtime for normal package distribution. Standalone SEA builds still include Node and have version/platform/code-cache constraints. | Consider an additional runtime-based distribution if users request it. Not a compelling rewrite for this audit's bugs. [S22] |
| **Go** | Native executable, standard `os/exec`, established CLI/supervision ecosystem. | Rewrite and migration cost. Shell semantics, PTYs, readiness, ownership, and process-tree cleanup still require deliberate implementation. | Best candidate for a small prototype **if measured distribution size or startup becomes an adoption problem**, or maintainers prefer Go. Not an inevitable destination. [S23] |
| **Rust** | Native binaries, strong types, mature CLI parsing with Clap, control over memory and terminal integration. | Larger implementation investment, especially for unfamiliar maintainers. The current bottleneck is correctness, not CPU-intensive computation. | Choose only with a concrete constraint or existing team expertise. No evidence currently justifies a port. [S28] |

Do not replace Execa with raw `Bun.spawn` merely to lower a dependency count while process cancellation is already broken. Execa's stream/cancellation facilities are useful. Fix the way they are used and keep ownership tests independent of the spawn API.

Likewise, do not replace `dotenv.parse` with an improvised parser or rely on Bun's automatic dotenv loading. F04 demonstrates why explicit project-scoped parsing is necessary.

### 4.2 Existing tools to reuse or integrate with

| Technology | What it can own | Fit for RUNIT | Important limitation |
|---|---|---|---|
| **Docker Compose** | Container startup, effective config, profiles, healthchecks, logs, shutdown. | **Adopt its native behavior now**, not another Compose implementation. | Detached `--wait` changes lifecycle ownership, and missing healthchecks mean “running” rather than application-ready. [S05–S08] |
| **Process Compose** | Non-container process dependencies, readiness/liveness probes, recovery policies, logs, CLI/TUI control. | **Most relevant supervision alternative.** First support invoking an existing config as a normal action. | Adds an external tool and its own config/semantics. Test command quoting, signals, terminal interaction, and platform support before promising parity. [S10] |
| **Overmind** | Procfile-based workflows, tmux-backed process interaction, restart/stop/connect. | Strong option when a project already has a Procfile and wants interactive debugging. | Still depends on tmux and is not a general readiness-condition replacement. [S11] |
| **mprocs / dekit** | Interactive per-process terminal output and process controls. | Useful research for avoiding a new custom terminal implementation. | Upstream now states that mprocs was renamed to dekit and the old interface is `dekit mprocs`. Validate current packaging and behavior rather than recommending a stale installation recipe. [S12] |
| **just** | Named developer commands and finite task dependencies. | Invoke an existing `just dev` or explicit recipe. | A command runner is not automatically a persistent service supervisor. [S13] |
| **mise** | Tool versions, project environments, and existing tasks. | Useful for “from anywhere” launches with the correct runtime environment. | Tasks may install missing configured tools. Do not trigger setup or downloads during a read-only scan/doctor operation. [S19] |
| **uv** | Python project environments and execution through `uv run`. | High-value Python integration when the repository already uses uv. | Resolves environment availability, not unknown application entrypoints. `uv run` may sync dependencies. [S14] |
| **Turborepo / existing workspace runner** | A repository's existing task graph and launch scripts. | Prefer an explicit root `dev` command over rediscovering and bypassing its graph. | Do not start both the root orchestrator and all its children independently. [S25] |
| **Dev Containers** | A repeatable containerized development environment shared with editors and CI. | Respect an existing setup or offer a documented launch action. | Adds environment provisioning and container requirements beyond RUNIT's lightweight launcher scope. [S26] |
| **Nix / devenv** | Reproducible tools, services, environments, and process management. | Delegate when already adopted by a project. | Requiring Nix for every RUNIT user would substantially change onboarding and product scope. [S33] |

**Practical boundary:** RUNIT owns alias resolution, project location, explicit config selection, safe launch, and clear diagnostics. Existing project tools should continue owning their internal build graphs and runtime provisioning.

Do not add all these as new backend types. A normal configured command can already launch most of them once F07–F09 and F18 are fixed. Build an adapter only when repeated, real usage shows a gap that cannot be expressed safely as an action.

### 4.3 Performance and distribution measurements

A fresh Linux baseline build bundled **354 modules** and produced a **102,839,260-byte** executable. Gzip level 6 compressed it to **38,861,117 bytes**, about a **62% download-size reduction**. This does not reduce the installed executable or its runtime memory footprint.

Across 25 separate `--help` launches with warm filesystem caches and an isolated environment, median elapsed time was **58.15 ms**, with a **56.24–63.53 ms** range. These are local measurements, not cold-start guarantees or comparisons with Go/Rust.

| Proposal | Value | Decision |
|---|---|---|
| Ship a compressed release archive | Material reduction in transfer size without rewriting the runtime. | Worth doing with matching checksum/install changes. |
| Bun minification | The same baseline build with `--minify` produced **102,384,069 bytes**, a reduction of **455,191 bytes, or 0.44%**. | Low priority for download size. No startup-speed improvement was measured for this variant. |
| Bun bytecode | The suggested `--compile --minify --bytecode` build **failed on Bun 1.3.9** at the top-level `await` in `src/cli.ts:116`. | Not a one-flag optimization for this checkout. Resolve module-format/runtime compatibility and retest before recommending it. No bytecode size or startup-speed result was obtained. |
| Load interactive prompts only on edit/regeneration paths | Can avoid unnecessary initialization for help/list/start. | Consider after measuring, without splitting the project into a new framework. |
| Add scan caching | Could help very large repositories. | Do not add yet. No scan bottleneck was established. First avoid rescanning solely to restate an existing registration. |
| Rewrite for a smaller binary | Could reduce runtime distribution overhead. | Require a prototype benchmark and an actual size/startup requirement. Minification cannot remove the embedded Bun runtime. |

## 5. Useful additions

These are proposals, not features implemented by this review.

| Proposal | Addition | Why it matters | Scope boundary |
|---|---|---|---|
| P01 | **Explicit action selection and version reporting.** | Makes existing generated actions usable and bug reports reproducible. | Add the missing CLI surface, not a new task DSL. See F18. |
| P02 | **Safe attach/status/restart/stop, including individual services.** | Lets users inspect or restart one failed service without tearing down the whole stack. | Operate only on owned sessions/processes. Start with native tmux controls and define what happens to dependents when restarting a service. See F02 and F08. |
| P03 | **Readiness and one-shot task conditions.** | Allows database startup, migrations, and app startup to form a reliable sequence. | Decide whether to delegate before implementing recovery policies, timers, log matching, and a larger supervisor. See F10. |
| P04 | **Detection explanations and deliberate fallback.** | Users can see why a command was selected and correct a wrong guess. | Use deterministic repository evidence. Do not introduce AI inference or execute project scripts during scanning. See F12–F14. |
| P05 | **Machine-readable inspection.** | `--json` for list/plan/check/env-key origins enables scripts, CI, and editor integrations. | stdout contains the selected format, diagnostics go to stderr, secrets remain masked, and inspection has no project mutations. |
| P06 | **Project-scoped environment/tool support.** | Addresses the central “from anywhere” promise for Python, monorepos, and runtime managers. | Respect existing uv/mise/venv configurations. No automatic system-wide installation. See F04 and F15. |
| P07 | **Declared port/health diagnostics.** | Detects likely startup conflicts before launching the stack and shows useful local URLs. | Report, do not automatically kill port owners. Treat inferred ports as guesses and preflight checks as racy, not guarantees. |
| P08 | **Registration preview, explicit paths, relinking, and shell completion.** | Reduces accidental registrations and makes moved repositories/worktrees easier to use. | Show the proposed alias, root, config, and shim destination before registration. Accept an explicit project path and confirm replacing a registration. Complete aliases/actions without a persistent daemon. |
| P09 | **Run an existing local config without registering an alias.** | Lets a contributor try the shared project configuration without installing a command in `PATH`. | Proposed interface: `runit --start` with no alias uses `.runit.yml` in cwd. It must not write a registry, create a shim, or generate a missing config. Local tmux runs still require ownership isolation under F02. |
| P10 | **Recognize existing launch scripts and task definitions.** | Broadens useful coverage without guessing another framework's entrypoint. | Offer an existing `bin/dev`, declared `dev`/`start` task in Make/just/Task/mise, or `Procfile` workflow before inventing runtime commands. Preserve the project's runner and ask when choices are ambiguous. Do not execute tasks merely to discover them. |
| P11 | **Opt-in per-service logs.** | Preserves failure output for inspection after a service exits. | Reuse the selected supervisor's logging. For native tmux mode, evaluate `pipe-pane` with bounded retention and private files rather than building a logging daemon. See the constraints below. |

For P10, a manifest such as `go.mod`, `Cargo.toml`, or `pom.xml` is not enough to establish a launch command. A repository may be a library or contain several applications. Likewise, a `Procfile` can mix services and one-shot jobs. Prefer an existing supervisor invocation over a new parser/executor, and never launch both a root orchestrator and its child services independently.

For P11, `pipe-pane` captures future output and permits only one pipe per pane [S04]. Do not replace a user's existing pipe silently. Store opt-in logs under the XDG state directory, use private directory/file permissions, and enforce retention limits. Application output can itself contain secrets, so do not promise automatic redaction or upload logs. Verify startup-output capture, retention, and pipe cleanup before exposing `--logs`.

Before publishing a versioned JSON Schema, make the runtime validator strict and settle the actual supported fields. Then editor completion can be generated from the same contract instead of maintaining an independent schema by hand. Add the YAML language-server schema reference to generated configs once that schema exists, giving editors completion without introducing an editor extension.

## 6. Simplifications worth making

The repository does not need a broad architecture cleanup. There are a few specific cuts with useful maintenance value:

| Code | Cut | Replacement |
|---|---|---|
| C1 | The second YAML dependency and its type shim. | Updated `yaml` where static parsing is needed, plus canonical Compose inspection where available. Test merge semantics. `src/docker/compose.ts`, `src/types/js-yaml.d.ts`. |
| C2 | Blank-command autofix machinery after successful schema parsing. | Reject invalid commands and let users edit intentionally. `loadConfig()` already requires a nonempty command, so that normal-editor autofix path cannot repair it. `src/commands/edit.ts:25–75`. |
| C3 | Duplicate `Task`/`Pane` shapes and schemas. | One existing runnable shape/schema reused under both names if necessary. `src/types/config.ts:1–17`, `src/core/config.ts:9–25`. |
| C4 | Unused `expandHome`, `collectDependencies`, and unused scan flags such as `hasSrc`, `hasAppDir`, `hasServerDir`. | Remove after checking callers. These currently add code or filesystem probes without affecting behavior. |
| C5 | The local declaration overriding `@inquirer/prompts` types. | Use the package's shipped TypeScript declarations unless a documented compatibility issue requires a targeted workaround. `src/types/inquirer-prompts.d.ts`. |

These are roughly **100–150 lines of potential reduction**, not a measured patch, and **one direct dependency** can be removed. Removing `js-yaml` would also make its otherwise-unused transitive `argparse` dependency unnecessary in this lockfile. Do not spend a release extracting every repeated three-line helper.

Keep Commander, Zod, the remaining YAML parser, and the current test runner. They solve real problems. Avoid a custom argument parser, dotenv parser, dependency injection system, generalized detector plugin API, or a second testing framework.

## 7. Delivery plan and acceptance gates

Use gates rather than speculative release dates. The scope below is deliberately sequenced so new features do not depend on broken execution behavior.

### M1. Safety patch

Address F01–F08 and F20, with a CI regression gate from F21.

| Gate | Required evidence |
|---|---|
| G01 | Alias traversal, shell syntax, prototype names, command collisions, and symlink cases cannot overwrite unrelated files. |
| G02 | Launch never kills an unrelated session and repeated launch does not implicitly restart an owned one. |
| G03 | Dummy secrets are absent from pane capture and diagnostics. Caller-directory dotenv files do not influence another registered project. |
| G04 | No-op editing preserves content, metadata changes survive, and regeneration detects meaningful differences. |
| G05 | Compound commands behave correctly, failures abort required siblings, and signals leave no owned descendants. |
| G06 | Both parser advisories and malformed-input handling are checked with updated locked dependencies. |

This is the release worth shipping first. Do not wait for new runtime detectors or a new TUI.

### M2. Execution and inspection contract

Address F09–F11 and F15–F19, then P01, P09, and the minimal ownership-based portion of P02.

Test long-running output, stdin, process exit codes, actual dependency edges, strict schema validation, environment precedence, concurrent registrations, and selected-action diagnostics. Use dedicated tmux sockets for integration tests, including user base-index settings and small terminal dimensions. For P09, verify that an existing local config runs without registration/shim writes, a missing config fails without generating one, and local tmux runs cannot collide with unrelated sessions.

Define readiness semantics before changing the meaning of existing `dependsOn` configurations. If that changes behavior, provide an explicit migration path rather than silently redefining every existing file.

### M3. Detection and Compose correctness

Address F12–F14, then P04, P10, and the necessary portion of P06.

Use fixtures for root scripts, declared workspace patterns and exclusions, mixed runtimes, duplicate names, Python environments, multiple Compose filenames, profiles, and overrides. For P10, cover an explicit launch script, an existing task runner, conflicting candidate commands, and a library-only repository. Verify that discovery never starts commands or installs tools. Preserve user-owned configuration as the authority once generated.

### M4. Distribution and optional product expansion

Complete F21–F23. Verify checksums, failed-install preservation, platform asset selection, and actual macOS execution. Decide the project name/license and document the configuration contract.

Only then evaluate Process Compose against a representative mixed project. Compare configuration complexity, setup friction, failure reporting, terminal interaction, cleanup, and maintainable RUNIT code removed. Keep the existing path if the integration adds more burden than it removes.

For P05, P07, P08, and P11, require a concrete user workflow and a small acceptance test before broadening the CLI surface. Registration preview must be cancellable without writes. Relinking must not orphan owned shims or replace another project's registration without consent. Log retention must stay bounded and must not overwrite an existing user-configured pane pipe.

## 8. What not to add now

| Decision | Do not add | Reason |
|---|---|---|
| N1 | Redis, a network database, or a background service for aliases. | There is no cross-host coordination requirement. Fix local file transactions first. |
| N2 | A web dashboard, remote-control API, accounts, or cloud sync. | Adds security and operational work unrelated to dependable local launch. |
| N3 | AI-generated startup commands as an automatic execution path. | The current deterministic guesses already need safer evidence and fallback behavior. |
| N4 | A universal supervisor or a large backend plugin framework. | Evaluate one real integration before designing abstractions around hypothetical ones. |
| N5 | Native Windows support based only on a Windows binary target. | Process groups, shell commands, terminal handling, shims, and tool checks all need a coherent Windows design. WSL remains the documented route. |
| N6 | A mandatory Go/Rust rewrite or major dependency upgrades solely because they are newer. | Fix the demonstrated failures and gather measurements first. Security fixes are an exception, not optional cleanup. |

A `cwd` outside the project is not meaningfully a sandbox escape when trusted commands can already access the user's filesystem. Document that trust boundary rather than adding a path restriction that falsely implies isolation.

## 9. Research references

All references were retrieved or inspected on **2026-09-06**. These are upstream documentation/source or primary security advisories, not evidence that RUNIT integrations have already been implemented. Version-specific references are identified where relevant.

| Source | Reference | Used for |
|---|---|---|
| S01 | [Bun standalone executables](https://bun.sh/docs/bundler/executables), [environment variables](https://bun.sh/docs/runtime/environment-variables), plus local `bun build --help` | Autoloading, targets, binary packaging, minification/bytecode, signing. |
| S02 | [Execa 9.6.1 output](https://github.com/sindresorhus/execa/blob/v9.6.1/docs/output.md), [termination](https://github.com/sindresorhus/execa/blob/v9.6.1/docs/termination.md), installed option types | Buffer limits, streaming, stdio, cancellation scope. |
| S03 | [Execa 9.6.1 shell behavior](https://github.com/sindresorhus/execa/blob/v9.6.1/docs/shell.md) | Explicit shell choice and argv/string distinctions. |
| S04 | [tmux upstream manual](https://github.com/tmux/tmux/blob/master/tmux.1), validated where noted against local tmux 3.2a | Exact targets, object IDs, process creation, environment/cwd, session behavior. |
| S05 | [Compose startup/shutdown order](https://docs.docker.com/compose/how-tos/startup-order/) | Started vs healthy vs completed successfully. |
| S06 | [docker compose config](https://docs.docker.com/reference/cli/docker/compose/config/) | Canonical effective configuration and service inspection. |
| S07 | [Compose profiles](https://docs.docker.com/compose/how-tos/profiles/), [merging Compose files](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/) | Explicit-service profile activation and multi-file semantics. |
| S08 | [docker compose up](https://docs.docker.com/reference/cli/docker/compose/up/) | `--wait`, detached mode, failure/exit options, lifecycle ownership. |
| S09 | [yaml package documentation](https://eemeli.org/yaml/) | Document API, comments, merge support, parser options. |
| S10 | [Process Compose](https://github.com/F1bonacc1/process-compose), [configuration](https://f1bonacc1.github.io/process-compose/configuration/), [health checks](https://f1bonacc1.github.io/process-compose/health/) | Alternative native-process supervision and its behavior. |
| S11 | [Overmind documentation](https://github.com/DarthSim/overmind) | Procfile workflows, tmux control, process restart/connect, environment handling. |
| S12 | [Upstream legacy mprocs README in dekit](https://github.com/pvolok/dekit/blob/master/README-mprocs.md) | Interactive process UI and current rename notice. |
| S13 | [just documentation](https://github.com/casey/just) | Reuse existing recipes instead of creating another command language. |
| S14 | [uv project guide](https://docs.astral.sh/uv/guides/projects/), [running project commands](https://docs.astral.sh/uv/concepts/projects/run/) | Virtual environments, `uv run`, environment syncing, signal behavior. |
| S15 | [pnpm 10.x workspace-file reference](https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/pnpm-workspace_yaml.md) | Workspace globs, exclusions, root inclusion. |
| S16 | [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces), [Node package manager metadata](https://nodejs.org/api/packages.html#packagemanager) | Explicit workspace and package-manager declarations. |
| S17 | [dotenv 16.6.1 documentation](https://github.com/motdotla/dotenv/blob/v16.6.1/README.md) | Parsing, override behavior, controlled environment targets. |
| S18 | [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) | Config/state locations, absolute path overrides, private runtime directories. |
| S19 | [mise tasks](https://mise.jdx.dev/tasks/) | Existing tool/environment-aware project tasks and installation side effects. |
| S20 | [GitHub Actions security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) | Immutable action references and minimum token permissions. |
| S21 | [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations) | Build provenance and verification. |
| S22 | [Node single-executable applications](https://nodejs.org/api/single-executable-applications.html) | SEA capabilities, active-development status, cross-platform code-cache restrictions. |
| S23 | [Go os/exec](https://pkg.go.dev/os/exec) | Native process API and explicit shell semantics. |
| S24 | [The established UNIX runit project](https://smarden.org/runit/) | Naming collision and distinction from this developer launcher. |
| S25 | [Turborepo running tasks](https://turborepo.com/docs/crafting-your-repository/running-tasks) | Existing root orchestration and workspace graph execution. |
| S26 | [Dev Container specification overview](https://containers.dev/overview) | Reusable development-environment metadata and Compose integration. |
| S27 | [Node child_process documentation](https://nodejs.org/api/child_process.html) | Child lifecycle, stdio, process termination limitations. |
| S28 | [Clap documentation](https://docs.rs/clap/latest/clap/) | Rust CLI tooling and explicit compile-time/binary-size tradeoffs. |
| S29 | [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp) | Locked `yaml` stack-overflow advisory and patched version. |
| S30 | [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) | `js-yaml` repeated merge aliases advisory. |
| S31 | [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) | `js-yaml` merge-chain advisory. |
| S32 | [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | `js-yaml` ordered-map advisory and patched-version metadata. |
| S33 | [devenv](https://devenv.sh/) | Existing Nix-based environment and process-management scope. |
| S34 | [Command Line Interface Guidelines](https://clig.dev/) | Exit codes, structured output, noninteractive behavior, and discoverable CLI contracts. |

**Bottom line:** Keep the current implementation language. Make RUNIT safe to invoke repeatedly, faithful to user configuration, and honest about what it detected. Then extend it by reusing the tools each project already trusts.

---

## 10. Addendum: verified naming data and shim-dispatch correction

Added 2026-09-06. Closes two open questions raised above. All checks run on this machine on that date.

### 10.1 F23 asks that availability be checked before renaming — here is that data

Blockers are `brew`, `apt`, and `PATH`. The npm name matters far less than assumed: a scoped package (`@owner/name`) with `bin: {"<name>": ...}` decouples the published package name from the typed command, so a registered-but-dead npm name is not disqualifying. `runit` fails all three real blockers: `apt` (`runit 2.1.2-44ubuntu2`, service supervision), `brew` (`homebrew/core`, UNIX service tools), and a live npm package.

Candidates below are free on brew, apt, and PATH. npm figure is weekly downloads (`api.npmjs.org`); **404** means the name is entirely unregistered.

| Name | Len | npm/wk | Note |
|---|---|---|---|
| **spinup** | 6 | 6 | "spin up the environment" is the phrase already in use; the name teaches the tool |
| **hangar** | 6 | 3 | Where craft are prepped; a hangar holding many aircraft maps onto the project registry |
| **liftoff** | 7 | 0 | Registered but zero usage |
| **rigup** | 5 | **404** | Wholly unregistered on npm |
| **devup** | 5 | 11 | Most literal option |
| **runup** | 5 | 4 | One letter from `runit`; lowest rebrand cost, preserves muscle memory |
| **tarmac** | 6 | 7 | |
| **gantry** | 6 | 4 | Launch tower |
| **muster** | 6 | 7 | Assemble the crew; fits multi-service startup |
| **allup** | 5 | **404** | |
| **runly** | 5 | **404** | Invented, so the cleanest search results of any candidate |
| **bringup** | 7 | 1 | Established embedded-systems term for bootstrapping |

**Verified collisions — do not use:** `ignite` (brew taken, plus Infinite Red's CLI), `atlas` (brew taken), `bridge` (already on PATH on this machine), `kickoff`/`rally`/`pilot` (apt package exists), `throttle` (26,740 npm downloads/week), `launchpad` (5,298/wk plus Canonical owns the term), `runway` (Runway ML), `upspin` (npm-free but it is Rob Pike's project), `quay` (free, but the "kee" pronunciation defeats word-of-mouth).

Every short-word GitHub org is taken; irrelevant, since the repository stays under the existing account.

**Note on sequencing:** F23's guidance to not delay correctness work for branding still holds. This table exists so that when the decision is made it takes an hour, not a week. Suggested default is `spinup`; `runup` if minimizing migration cost dominates. After setup users type the alias (`my-app`), not the tool name, so the tool name is typed rarely — optimize for memorable over short.

### 10.2 Correction to the shim-dispatch refutation in F01

F01 states that replacing Bash wrappers with symlinks "is not a working drop-in solution" because compiled invocation puts a virtual bundle path in `process.argv[1]` and `process.execPath` resolves to the real binary. **Both observations are correct, but the conclusion is too strong.** `process.argv0` preserves the invoked name and makes busybox-style dispatch viable.

Measured with a compiled Bun 1.3.9 binary reached through a symlink named `my-app`:

| Value | Via symlink path | Via PATH lookup |
|---|---|---|
| `process.argv0` | `/…/my-app` | **`my-app`** |
| `process.argv[0]` | `bun` | `bun` |
| `process.argv[1]` | `/$bunfs/root/argvbin` | `/$bunfs/root/argvbin` |
| `process.execPath` | `/…/argvbin` (real target) | `/…/argvbin` |

So `path.basename(process.argv0)` yields the alias in both cases. Dispatch is feasible; it simply must read `argv0`, never `argv[1]` or `execPath`.

This does **not** overturn F01's recommendation to keep quoted wrappers for now. `argv0` is set by the calling process and is therefore attacker-controlled input in the same class as any other argument, so it must be validated against the registry rather than trusted. Ordinary shells set it faithfully, but a caller using `execve` can set it to anything. The decision stands on its own merits; the reasoning above should replace the claim that the mechanism does not work.

**Acceptance if adopted:** a symlink invoked through PATH, through a relative path, and through an absolute path all resolve to the same registered alias; an `argv0` value not present in the registry is rejected rather than executed.
