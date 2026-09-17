# Spinup reliability implementation handoff

> **Historical record.** Written on 2026-09-06 as the implementation brief for M1–M4. All
> findings it lists were closed by v0.5.0; current status is in [SPINUP_PLAN.md](SPINUP_PLAN.md).

## 1. Purpose and verified baseline

This is my recommended implementation plan for another coding agent. It covers all 23 findings from `RUNIT_REVIEW.md`, the six findings from the follow-up review, and the additional config-permission regression. It describes work to do, not fixes already implemented.

Reviewed on **2026-09-06**, against **`7ad743e630759e77ca13a66f8aebec38944ab6cb`**, package version **0.3.0**. The working tree was clean. The environment/diagnostics commit `209d45d`, discussed in an earlier review, is **not in this checkout**. Do not assume its changes or its 65-test result are present.

| Baseline check | Observed result |
|---|---|
| `bun run check` | Passed. Currently checks source only, not tests. |
| `bun test` | 55 passed, 0 failed, 102 assertions across 8 files. |
| `bun audit` | No vulnerabilities found. |
| `bash -n install.sh scripts/build-release.sh` | Passed. |
| Fresh Linux standalone build | Passed, including help/version and a harmless project launch. |
| Compiled caller-directory dotenv canary | Passed. |
| ShellCheck | Not installed locally. It is configured in CI. |

Environment: Linux x64, Bun 1.3.9, Node 22.14.0, tmux 3.2a and Docker Compose 2.34.0. Probes used temporary homes, dummy secrets and private tmux servers. No real project containers were started. macOS/ARM execution, public downloads and third-party supervisor integrations were not tested.

**Evidence terminology:** “Reproduced” means a focused probe exercised the behavior. “Source-confirmed” means the implementation still contains the problem, without every listed variation being executed. Acceptance checks below are requirements for the implementing agent, not claims that those checks already exist or pass.

### Finding identifiers

Keep these identifiers in commits, tests and completion reports. Do not count the follow-up aliases as separate copies of the same finding.

| Follow-up ID | Original finding | Meaning |
|---|---|---|
| R1 | F01 | Unsafe shim writes through symlinks. |
| R2 | F02 | Destruction of exact-name tmux sessions. |
| R3 | F08 | Incomplete descendant cleanup and incorrect CLI exit status. |
| R4 | Additional finding | Broken legacy migration and invalid collision suffixes. |
| R5 | F15 | Incorrect effective environment, including stale tmux inheritance. |
| R6 | F05 | Interactive editing loses cross-window dependencies. |
| R7 | Additional finding | Atomic config replacement widens file permissions. |

F04, F07 and F20 have verified fixes to preserve. The other 20 original findings remain open or partially fixed. R4 and R7 add two further work items. Some “fixed” labels in `RUNIT_REVIEW.md` cover only a subset of their original acceptance criteria.

Priorities: **P0** is immediate safety work, **P1** is subsequent reliability work, and **P2** is remaining documentation/packaging work. Support claims must match the scope actually tested.

## 2. Implementation direction

| Decision | Recommendation |
|---|---|
| D1 | Keep TypeScript, Bun, Execa, Commander, Zod, dotenv and the updated YAML parser. Do not rewrite the runtime or replace dependencies just to reduce their count. |
| D2 | Finish file safety, session ownership, editing, migration and process cleanup before feature expansion. Fix shared boundaries, not individual callers. |
| D3 | Let Docker Compose resolve and run Compose applications. Do not maintain a second incomplete Compose implementation. |
| D4 | Evaluate Process Compose before implementing substantial native readiness/supervision. It is a researched candidate, not a verified integration. |
| D5 | Prefer existing project-owned launch commands and configurations over guesses. No general backend/plugin framework is needed for invoking a command. |
| D6 | Keep the chosen Spinup name and MIT license. Repair compatibility and documentation rather than reopening branding work. |

Use existing helpers and the Bun test suite. A small shared persistence helper is justified where registry/config/shim code needs the same guarantees. A generic transaction framework, database, daemon, new TUI or detector plugin system is not.

Treat project commands as trusted code running with the user's privileges. A configurable cwd is not a sandbox. Alias paths, generated files, accidental secret disclosure and owned process/session cleanup are separate safety boundaries. Do not publish releases, push tags, modify real user registrations or install outside isolated test directories without explicit authorization.

### Delivery order

| Milestone | Work and sequencing |
|---|---|
| M1: safety | Add focused regressions while fixing F01, R7 and F19 persistence boundaries. Then R4 migration and F05/F06 editing. Fix F02/F03 tmux ownership/error handling and F08 cancellation. Preserve F04/F07/F20. Run the relevant tests after each change. |
| M2: execution contract | Implement F18 action routing, F17 validation, F15 environment resolution and F16 diagnostics as coordinated small changes so inspection and launch use the same selected action. Finish F09/F11. Resolve F10's supervision decision explicitly. |
| M3: detection and Compose | Address F12–F14 together. Prefer authoritative commands, resolve service identities before dependency inference, and delegate Compose configuration/lifecycle. Coordinate readiness work with F10. |
| M4: distribution | Finish F21/F22 and update F23 from actual behavior and execution evidence. Extend CI as fixes land, rather than waiting until this milestone to add regressions. |

Do not run prompts, editors, scans or network calls while holding the registry mutation lock. Do not silently redefine existing `dependsOn` behavior. Do not mark an item closed because a narrow happy-path test passes.

## 3. File safety, migration and editing

### F01 / R1. Shim ownership and symlink writes

**Priority:** P0. **Status:** partial. **Evidence:** reproduced.

**Location:** `src/core/shim.ts:13–22,40–54,86–141`, callers in `src/commands/run.ts`, `src/commands/remove.ts` and `src/cli.ts`.

**Problem:** Ordinary foreign files are protected, but `readFile()` follows symlinks. A dangling link looks like a missing file, and `writeFile()` creates its target outside the shim directory. An existing link to marker-bearing content can also be followed. A marker found anywhere in a file is weak ownership evidence.

**Recommended fix:** Retain canonical alias validation and containment checks. Classify filesystem entries with `lstat`, reject shim symlinks including dangling ones, and require a regular file with a recognized complete wrapper format before refreshing or deleting it. Create new entries exclusively, not with a check-then-overwrite sequence. Replace approved owned wrappers using an exclusively created temporary file in the destination filesystem and an atomic rename, coordinated with F19. Recheck destination identity before replacement. Never infer an unsafe legacy path by taking its basename and deleting the resulting file.

`lstat` alone is not a race-proof write primitive. Exclusive creation protects absent destinations, and atomic replacement avoids following a final symlink. Tool locks only coordinate cooperating Spinup processes. Validate the writable-directory trust boundary and do not promise protection against arbitrary concurrent same-user filesystem mutation.

**Acceptance:** Traversal and shell metacharacters remain rejected. Unregistered prototype-like names never resolve to inherited values. PATH collisions remain protected. Regular foreign files, symlinks, dangling links, directories and symlink targets remain unchanged. Owned wrappers refresh and remove successfully. Test concurrent creation of the same alias, and ensure no partial executable becomes visible.

### R7. Config replacement loses restrictive permissions

**Priority:** P0. **Status:** open. **Evidence:** reproduced.

**Location:** `src/core/config.ts:178–188`. Review the corresponding registry/temp-file behavior in `src/core/registry.ts:146–157`.

**Problem:** Saving an existing `0600` config with umask `022` changes it to `0644`. The new inode gets default permissions rather than the original file's restrictions. Configs may contain explicit task environment secrets.

**Recommended fix:** Preserve the existing regular file's permission mode when replacing it. Create new config/state files, backups and intermediate files privately, with `0600` as the default for files that can contain secrets. Set the final intended mode before publishing the replacement. Use exclusive unpredictable temporary names in the destination filesystem. Do not chmod shared parent directories or unrelated files. Define config-symlink behavior explicitly instead of silently replacing a link with a regular file.

Preserving mode bits does not automatically preserve ownership or ACLs. Do not silently widen access in environments using those controls. Either preserve the supported metadata or refuse the operation with a clear explanation.

**Acceptance:** Under umask `022`, a saved `0600` config remains `0600`. New secret-bearing files and backup/temp files are private. Intentionally different existing modes follow the documented preservation policy. Failed serialization, write or rename leaves the original bytes and permissions intact.

### F19. Registry, shim and config operations can leave inconsistent state

**Priority:** P0 for shared safety foundations, P1 for remaining recovery work. **Status:** partial. **Evidence:** source-confirmed, with concurrent registry updates already passing.

**Location:** `src/core/registry.ts:97–220`, `src/core/config.ts:178–193`, `src/core/shim.ts:111–112`, `src/commands/run.ts:220–257`, `src/commands/remove.ts:11–12`.

**Problem:** The registry lock fixes ordinary lost updates, and registry/config replacement is atomic per file. That does not make a registration, removal or migration atomic across files. Shim writes remain in place. Removal deletes the registry entry before attempting shim removal. A failed registration after shim creation can leave an orphan wrapper.

**Recommended fix:** Keep the registry as the authority for which aliases can launch. Reuse the existing cross-process lock for short coordinated mutations, without nesting calls that reacquire it. Validate config and preflight destinations before writes. Stage approved content privately and publish individual files atomically. Roll back newly created owned artifacts on ordinary failure, without deleting pre-existing or subsequently changed files.

For removal, preflight ownership and make failure recoverable. Removing an owned wrapper before committing registry removal is preferable to losing the authoritative entry while leaving a runnable wrapper. A failed removal must not report success. A registered alias with a missing wrapper can be repaired safely on a later explicit launch. An orphan wrapper must report “not registered,” never register the caller's directory or run an inferred project. This recovery model avoids a general transaction journal.

Do not use age alone as proof a lock holder is dead. Prefer an actionable timeout and explicit stale-lock recovery over unsafe automatic eviction. If automatic recovery remains, it must not remove an active or replacement lock. Atomic rename protects visibility, not guaranteed power-loss durability. Use file/directory synchronization if claiming the latter, or state the narrower guarantee.

**Acceptance:** Repeat concurrency tests using separate OS processes. Inject failures in shim creation, registry replacement, config replacement and removal. Verify authoritative entries, file contents and ownership after each failure and after retry. Test interrupted operations and same-alias contention. Preserve absolute XDG overrides and rejection of relative overrides.

### R4. Legacy migration breaks old installations

**Priority:** P0. **Status:** open. **Evidence:** reproduced, with additional compatibility cases requiring tests.

**Location:** `src/cli.ts:20–56`, `src/core/shim.ts:32–37,86–129`, `src/core/registry.ts:74–89,244–292`.

**Problem:** Actual v0.2.2 wrappers contain no marker. Their body is `#!/usr/bin/env bash` followed by `runit --start "<alias>" "$@"`. Migration ignores them and launch rejects them as foreign. Collision handling also appends `-2` to an already 64-character alias, creating an unusable 66-character key. Registry mutation currently precedes successful wrapper migration.

**Recommended fix:** Recognize the exact known historical wrapper formats as inert text, tied to the corresponding registered alias. Never execute or source a legacy wrapper to identify it, and never treat an arbitrary mention of `runit` as ownership. Build and validate the entire rename plan first, checking both registry names and filesystem/PATH collisions. Reserve room for suffixes within the 64-character limit.

Use F01/F19's coordinated mutations and recovery behavior. Preserve entries that cannot be migrated, and explain the required manual action. Report legacy-directory adoption errors rather than silently starting with an apparently empty registry. Do not overwrite an existing new registry while adopting old state.

Handle case-insensitive filesystems: creating `myapp` and then reclaiming `MyApp` can remove the same file. Determine whether the paths refer to the same entry before applying the plan. Never reclaim an unsafe old alias by deleting a different canonical alias with the same basename.

**Acceptance:** Upgrade a fixture containing the real unmarked v0.2.2 wrapper, a marker-bearing RUNIT wrapper and a current Spinup wrapper. Cover case-only renames, punctuation, 64-character collisions, PATH conflicts, unrescuable names, an existing destination registry and interrupted migration. Run the case-insensitive cases natively on macOS. Repeating migration must be harmless, and each alias must still launch its original project from an unrelated cwd.

### F05 / R6. Editing can still change untouched configuration

**Priority:** P0. **Status:** partial. **Evidence:** reproduced.

**Location:** `src/core/interactive.ts:18–110,158–171`, `src/commands/edit.ts:47–100`.

**Problem:** The simple-task metadata fix works, and external-editor no-op saves now preserve bytes. Interactive tmux save still prunes dependencies against only the edited window, moves that window to the front and adds a layout when none was configured. References from untouched windows to a removed service are not handled. Interactive serialization also loses comments/formatting.

**Recommended fix:** Apply edits to the original action/window in its original position. Preserve fields that were not selected for modification, including the absence of optional fields. On service removal, remove references to that specific removed service across the entire action, not every reference outside the edited window. Never prune dependencies on still-existing services.

Track whether any edit occurred and skip writing on a save-only pass. For actual structured edits, use the installed YAML Document API to update the affected nodes and preserve unrelated comments/content. Avoid a second config model or a custom merge engine. Mode conversion must explain and explicitly confirm any loss of windows/services rather than merely printing a warning.

**Acceptance:** Save-only simple and multi-window tmux edits preserve file bytes, dependency references, order and metadata. Changing one command preserves unrelated comments. Removing a service fixes inbound references from all windows while preserving other edges. External editors with arguments still work, and a no-op editor still leaves bytes intact.

### F06. Regeneration previews are incomplete and inconsistent

**Priority:** P0. **Status:** partial. **Evidence:** reproduced, with absent recovery behavior source-confirmed.

**Location:** `src/commands/run.ts:105–257`.

**Problem:** The new comparison detects swapped commands, but misses environment-value changes, task ordering and window identity/layout. First registration with `--regenerate` skips confirmation. A rejected alias can already have overwritten the config. There is no recoverable original.

**Recommended fix:** Route every overwrite through one preflight/preview/confirmation path, whether registered or not. Check alias and destination ownership before touching the config. Compare complete validated structures for semantic equality and original bytes for file equality. Do not use the completeness of a display summary to decide whether a change exists.

Prefer a small structural comparison that covers all supported fields and preserves array order. Show which environment keys changed without printing their values. If content will be rewritten but the display summary cannot explain every change, say so explicitly rather than claiming “no structural changes.” Describe regeneration as replacement, including loss of custom actions, comments and formatting. Require explicit consent, fail closed without a prompt response, and retain a private original backup before replacement.

**Acceptance:** Preview command swaps, order changes, env-value changes, window changes and removed custom actions. First-registration regeneration follows the same policy as an existing alias. Cancellation or alias rejection leaves config, registry and shim unchanged. A backup preserves the exact old bytes without widening permissions.

## 4. tmux and process execution

### F02 / R2. Relaunch destroys exact-name sessions

**Priority:** P0. **Status:** partial. **Evidence:** reproduced.

**Location:** `src/tmux/runner.ts:108–122`, `src/tmux/session.ts:37–159`.

**Problem:** Exact targeting protects prefix matches, but a session with the exact alias is still killed regardless of ownership. Repeated launch destroys running work.

**Recommended fix:** Mark newly created sessions with Spinup ownership metadata including canonical project identity, alias and selected action. Use stable session IDs after creation. If an existing session is owned by this same project/action, attach or switch to it. If it is unowned or belongs to another project/action, fail without modifying it. Do not infer ownership from the name or take over existing unmarked sessions automatically.

Remove the unconditional kill path. A restart operation is not required to solve this bug. If added later, it must be explicit and limited to the identified owned session. Clean up setup failures only by the ID returned for the session created by this invocation. Do not change global tmux settings to implement ownership.

**Acceptance:** Repeated launches preserve the original pane/process IDs. An unowned exact-name session and a longer prefix-matching session survive. Cross-project/action collisions fail safely. Cover noninteractive output and switching from an attached tmux client.

### F03. tmux failures expose environment secrets

**Priority:** P0. **Status:** partial. **Evidence:** reproduced with a missing-pane failure.

**Location:** `src/tmux/layout.ts:9–22,56–66`, error propagation through `src/tmux/runner.ts` and `src/cli.ts:170–174`.

**Problem:** Native tmux environment passing fixed typed exports in scrollback. Execa errors still include the full command, including `-e KEY=secret`. The CLI prints that message.

**Recommended fix:** Sanitize failures at the shared tmux invocation boundary, not only in the CLI catch. Report operation, safe target identity and exit status without echoing argv, environment assignments or the configured shell program. Include only safe/redacted stderr. Do not attach an unredacted cause that other diagnostic paths will serialize. Apply the same policy to future debug output and telemetry.

Keep native environment handoff. Do not return to `send-keys`, disk scripts containing secrets or blanket logging of resolved environments. Values passed as command arguments may still be inspectable briefly by same-user processes. This fix addresses accidental terminal/diagnostic disclosure, not a secret vault.

**Acceptance:** Use a dummy secret that the application itself does not print. It must be absent from pane capture, stdout, stderr, setup errors and diagnostic output. Test a disappeared pane or injected tmux failure, not just a successful launch. Ensure errors still identify the failed operation.

### F08 / R3. Cancellation and exit codes are incomplete

**Priority:** P0. **Status:** partial. **Evidence:** reproduced.

**Location:** `src/core/executor.ts:94–284`, `src/cli.ts:170–174`.

**Problem:** Basic sibling fail-fast works. The single-task path does not own a separate process group, and direct SIGTERM to the launcher leaves descendants alive. Cleanup filters on immediate-child state, which is insufficient to determine whether a process group has surviving descendants. CLI error handling discards `TaskFailure.exitCode`. SIGINT/SIGTERM handling does not consistently distinguish their statuses.

**Recommended fix:** Give cancellation one owner and await one shared shutdown operation. On supported POSIX platforms, track the process groups created for tasks, signal only those groups, allow a bounded grace period and then force termination of survivors. Do not discard group ownership merely because its original shell exited. Do not signal Spinup's foreground group, search by process name or use broad `pkill` cleanup.

Audit Execa's automatic cleanup against explicit group shutdown so it cannot short-circuit the awaited cleanup. Do not rely on asynchronous work in the process `exit` event. Preserve the originating task failure and return its valid exit status at the CLI boundary. Use 130 for handled SIGINT and 143 for handled SIGTERM.

Separate stdin forwarding from group ownership. A minimal simple-mode design can use owned groups and forward parent stdin to the sole task with backpressure, while multi-task input remains disabled. Test terminal behavior instead of assuming detached children can inherit a controlling terminal unchanged. Use the existing tmux backend for full-terminal interaction rather than adding a PTY framework as part of this patch.

**Acceptance:** Test single and multiple tasks with shell/child/grandchild chains, piped stdin, terminal Ctrl+C and SIGTERM sent directly to Spinup. Include a descendant that ignores SIGTERM and a shell that exits before its descendant. Cleanup must finish within the grace period plus a small allowance, leave no owned port/process alive and leave unrelated processes untouched. A task exiting 42 yields CLI exit 42.

### F09. Output forwarding ignores backpressure

**Priority:** P1. **Status:** partial. **Evidence:** source-confirmed. Large-output and stdin fixes already pass.

**Location:** `src/core/executor.ts:38–64,235–253`.

**Problem:** `buffer: false` removes Execa's 100MB capture ceiling, but the prefixer ignores the return value of `sink.write()`. A slow sink can accumulate unbounded queued output. Keeping only 64KiB of pending line text does not bound the sink's queue.

**Recommended fix:** Use the installed Node stream primitives for a backpressure-aware prefixing transform or equivalent bounded flow. Preserve UTF-8 decoding across chunks, the pending-line bound, stderr separation and single-task stdin. Do not buffer the complete task output in application code. Clean up stream listeners on cancellation and sink failure.

**Acceptance:** Retain the greater-than-100MB regression, but do not collect that entire output merely to assert completion. Add a deliberately slow Writable with a small high-water mark and verify upstream flow pauses or retained data stays bounded. Cover split Unicode, long unterminated lines, stderr and cancellation during blocked output.

### F10. Dependency order is not readiness or completion

**Priority:** P1. **Status:** open. **Evidence:** reproduced.

**Location:** `src/core/dependencies.ts:9–52`, `src/core/executor.ts:224–269`, `src/tmux/runner.ts:80–91`.

**Problem:** A dependent starts before a setup task has finished. Delays serialize unrelated later launches and do not prove a service is ready.

**Recommended fix:** Preserve existing string-array `dependsOn` as an explicitly documented started/order-only contract. Do not silently make every existing dependency wait for process exit, which would deadlock dependencies on servers.

My preferred direction is delegation: Compose owns container health and existing Process Compose configurations can own native readiness/completion. Before adding a native condition engine, run a small Process Compose prototype against a representative project and compare quoting, readiness, signals, cleanup, terminal interaction and setup friction. Invoking an existing project command does not require a backend framework.

If native conditions are still required after that decision, implement only explicit started, ready and completed-successfully conditions. Readiness needs a configured bounded probe, never a guessed endpoint. A failed one-shot prerequisite blocks its dependents, while independent services remain concurrent. Implement the same semantics in both backends or reject unsupported conditions before creating processes/sessions. Do not claim this finding is closed by documentation alone.

**Acceptance:** A delayed setup job finishes successfully before its dependent starts. An unready service blocks only its dependents. Probe timeout and prerequisite failure identify the blocker. Existing order-only configs keep their behavior. Record prototype results if delegation is chosen. No live database test has yet established these semantics.

### F11. tmux capacity and user settings remain fragile

**Priority:** P1. **Status:** partial. **Evidence:** reproduced for missing layout, source-confirmed for remaining terminal branches.

**Location:** `src/tmux/layout.ts:34–48`, `src/tmux/runner.ts:37–69`, `src/tmux/session.ts:92–159`.

**Problem:** Eight tiled panes work with one-based indexes, but eight panes without an explicit layout still fail. There is no deliberate constrained-terminal fallback. Placeholder panes start user-configured shells before being replaced. Client switching is attempted whenever `TMUX` is set, even without verifying an interactive client context.

**Recommended fix:** Choose an effective default layout before splitting and rebalance after each split regardless of whether the config explicitly named it. Capture and use IDs throughout. Use inert/empty placeholder panes supported by the declared tmux version rather than running user startup shells unnecessarily. Verify the exact tmux options against the minimum version you claim to support.

When the requested layout cannot fit, either offer an explicit window-per-service fallback or fail early with a clear actionable message. Do not silently rewrite user configuration or global tmux options. Noninteractive launches should return session identity/instructions, even if they inherited `TMUX`. Switch clients only in the appropriate interactive context.

**Acceptance:** Test explicit and omitted layouts, one/eight services, multiple windows, base indexes 0 and 1, small dimensions, setup failure and noninteractive execution with `TMUX` set. Verify actual attached-client switching separately. No partial session should survive a failed build.

## 5. Action, environment and validation contract

### F18. Non-default actions and shim arguments are inaccessible

**Priority:** P1. **Status:** partial. **Evidence:** reproduced.

**Location:** `src/cli.ts:79–166`, `src/core/shim.ts:32`, `src/commands/run.ts:415–437`, `src/core/generator.ts:65–91`.

**Problem:** `--version` works, but generated actions cannot be selected. The wrapper's unconditional `--start` conflicts with management flags. Unsupported task arguments are rejected, but there is no explicit supported routing contract.

**Recommended fix:** Add a visible `--action <name>` selector and make `--start` discoverable. Keep bare `spinup <alias>` as registration/status, not an implicit launch. Support selected actions in start, plan, graph, env, check and doctor. List available actions in existing inspection output. Reject unknown actions before writes or other side effects. Require `--action` to accompany launch or selected-action inspection rather than silently ignoring it during registration.

Keep quoted Bash wrappers. Replace their forced primary start action with a small internal invocation marker, such as `--from-shim`, handled centrally by Commander routing. That marker makes start the default only when no explicit management action was supplied. Do not duplicate argument parsing in Bash or switch to symlink/argv dispatch as part of this fix. Refresh recognized owned wrappers through R4/F01's safe migration path.

Explicit start and shim launch must require a registered alias. Neither may silently register the caller's cwd when a wrapper is orphaned. Continue rejecting task-argument passthrough until an intentional contract exists. Never concatenate unvalidated extra arguments onto a shell command.

**Acceptance:** Run `prisma-generate`, `prisma-migrate` and another non-default action without editing the default. Inspection uses that same selected action. Shim management flags work without launching services. Unknown actions, incompatible primary flags and unsupported extra arguments fail clearly. A missing registry entry cannot turn an old wrapper into registration of another directory.

### F17. Validation and inspection do not match execution

**Priority:** P1. **Status:** open. **Evidence:** reproduced for schema/graph cases, source-confirmed for plan omissions.

**Location:** `src/core/config.ts:10–105`, `src/core/dependencies.ts:9–66`, `src/commands/doctor.ts:48–68`.

**Problem:** Unknown keys disappear, cycles pass parsing, empty actions and whitespace commands validate, env names are unrestricted and tmux issue paths use incorrect flattened indexes. Independent nodes are rendered as a dependency chain. Plans show config order and omit dependency/delay details.

**Recommended fix:** Make supported configuration objects strict. Validate nonblank strings without rewriting the command text, require runnable entries, validate configured environment names and reject cycles using the existing dependency helper during load/validation. Preserve true window/pane coordinates when reporting errors. Validate newly supported fields from F10 explicitly rather than accepting and stripping them.

Render actual edges, such as `web depends on api, db`, and show independent services without arrows. A textual adjacency list is sufficient. Print the selected action's resolved launch order, resolved cwd, dependencies/conditions and delays. Include environment key origins where useful, not values. Configuration/schema failures must occur before creating a session or changing registry/shims.

**Acceptance:** Misspelled fields, cycles, blank commands, invalid env keys and empty actions fail clearly. Duplicate tmux service errors identify the real window/pane path. A branching graph has its actual edges, and independent nodes remain independent. The plan agrees with execution on selected action, order and resolved paths.

### F15 / R5. Environment resolution differs from user intent and across backends

**Priority:** P1. **Status:** open. **Evidence:** reproduced, with config-root handling source-confirmed.

**Location:** `src/core/env.ts:24–49`, `src/commands/run.ts:415–433`, `src/tmux/runner.ts:76–85`.

**Problem:** The current loader mutates global state, overwrites shell values, reads `.env.development` for unrelated actions and loads from the registered directory rather than `config.root`. The caller passes only file values to tmux, so an existing server contributes stale inherited values. The later `209d45d` attempt is absent, and merely dropping shadowed file keys would not solve tmux inheritance.

**Recommended fix:** Adopt an explicit policy: task `env` overrides the invoking shell, which overrides selected dotenv files. Resolve dotenv at `path.resolve(projectRoot, config.root)`. Apply `.env`, `.env.local`, `.env.<action>` and `.env.<action>.local` in that order. An action name is not automatically a deployment mode. Document the change from unconditional `.env.development` loading and warn when a previously implicit file is skipped.

Keep parsing pure and return the complete effective application environment plus file/key origins. Use it deliberately in both backends, not just the subset parsed from files. Preserve empty strings as intentional overrides. When using Execa, ensure automatic inherited-env merging cannot undo the chosen result.

For tmux, overriding present keys is not sufficient to remove obsolete server-only keys. Use a supported isolated session environment or an explicit clean-environment launch to enforce the chosen application environment. Preserve tmux-generated terminal metadata such as the new pane's `TMUX_PANE` rather than overwriting it with the caller pane's value. Do not modify the global tmux server environment. F03's error-redaction requirements apply to this handoff.

Give source-mode runs/tests an explicit Bun dotenv policy too. Preserve F04's compiled flags.

**Acceptance:** Test file order, shell overrides, task overrides, empty values, `config.root`, missing files and action-specific files. `--env` must not mutate `process.env`. Start the same project in simple and tmux modes against an old server with conflicting and server-only variables. Application env must agree apart from documented backend metadata. Inspection shows origins and override decisions while keeping values masked.

### F16. Diagnostics report success for unusable environments

**Priority:** P1. **Status:** open. **Evidence:** reproduced, with probe/inference limitations source-confirmed.

**Location:** `src/commands/check.ts:34–57`, `src/commands/doctor.ts:171–217`, `src/core/health.ts:56–154`.

**Problem:** Missing cwd still yields exit zero, and doctor prints ready without required tmux. A file passes the cwd check. Tool inference considers unrelated actions and detected stacks rather than the selected launch. Version probes have no timeout. Docker CLI presence proves neither Compose availability nor daemon connectivity.

**Recommended fix:** Have check and doctor consume the same selected-action validation result and derive both readiness text and exit status from it. Use `stat().isDirectory()` for cwd. Required failures and unresolved required checks must not produce an unconditional “ready.” Optional tool absence should stay informational.

Infer requirements from the actual selected commands and explicit generated metadata where available. Do not pretend regexes fully analyze arbitrary shell programs. Report unknown cases honestly. Do not require Node merely because a command uses Bun. Check the executable that will actually run: finding `python3` does not make a literal missing `python` command runnable. Respect selected uv/venv commands instead of inventing fallbacks only in diagnostics.

Bound tool probes and distinguish Docker CLI, Compose plugin and daemon requirements. Check the daemon only when the selected operation needs it. Reuse F17's semantic validation. Never auto-install tools during inspection.

**Acceptance:** Missing/wrong-type cwd, cycles and missing required tools give nonzero status in both commands. Missing optional Docker/tmux does not fail an unrelated action. Cover a Bun-only command, an explicit `python` command on a python3-only PATH, a Compose-less Docker CLI and a hanging version probe. Non-default action diagnostics must match the action actually launched.

## 6. Detection and Compose

### F12. Detection ignores project-owned intent and invents fallbacks

**Priority:** P1. **Status:** open. **Evidence:** reproduced for the fixture matrix, source-confirmed for additional heuristics.

**Location:** `src/core/scanner.ts:101–232`, `src/core/detectors/node.ts:121–198`, `src/core/detectors/python.ts:12–68`, `src/core/detector.ts:25–31,81–98`.

**Problem:** Root scripts disappear on the monorepo path. Workspace patterns outside fixed directories and nested Python services are missed. Declared package managers are ignored without lockfiles. Empty/library-only projects become `npm start`, and finite check/test scripts may be selected as development services. Python detection guesses entrypoints from substring matches.

**Recommended fix:** Treat an existing valid Spinup config as authoritative. On discovery, prefer an explicit root launch script or project-owned orchestration command before expanding workspaces into services. Honor supported workspace declarations and exclusions. Use native glob facilities where they satisfy the required patterns, verified with fixtures, rather than writing a glob parser.

Respect declared package-manager metadata and report conflicts with lockfiles. Inspect discovered service directories for their actual runtime, including Python manifests and existing uv/Poetry/venv arrangements. Verify entrypoints or present them as unconfirmed suggestions. Preserve existing task-runner commands rather than reimplementing their graphs.

Unknown/library-only projects should request an explicit command interactively or fail with an actionable message noninteractively. Do not persist a guessed runnable config or register it as successful. Detection must not start services or install dependencies. Record enough origin information to explain each proposed command without introducing a plugin architecture.

**Acceptance:** Cover root dev script plus library workspace, `components/*` and excluded workspaces, nested Python services, packageManager without a lockfile, conflicting metadata, empty projects and library-only packages. Confirm that check/test scripts are not silently chosen as development servers and no inspection starts commands.

### F13. Generated service identities collide

**Priority:** P1. **Status:** open. **Evidence:** reproduced.

**Location:** `src/core/detector.ts:34–75`, `src/core/detectors/node.ts:159–163,211–216`, `src/core/detectors/python.ts:23–25,39–41`, `src/core/generator.ts:38–58`.

**Problem:** Node and Python at root both become `app`. Node plus Compose `app` collides and creates an inferred self-dependency. Equal directory basenames collide too. Generated configs then fail their own validation.

**Recommended fix:** Assign stable unique runnable names before dependency inference. Keep simple names where unambiguous and disambiguate only collisions using runtime or relative path, for example `app-node`/`app-python` or `apps-api`/`services-api`. Resolve references using original service identity, not ambiguous bare names. Do not rename the actual service keys passed to Compose. Validate the entire generated config before writes.

**Acceptance:** Node/Python, Node/Compose and repeated workspace-basename fixtures produce valid configs with no unintended self-reference. Repeated scans preserve names, and noncolliding existing names do not change unnecessarily. Coordinate the resulting container-group identity with F14.

### F14. Compose detection and execution refer to different applications

**Priority:** P1. **Status:** open. **Evidence:** reproduced for file selection/profile generation, source-confirmed and research-backed for wider Compose semantics.

**Location:** `src/core/scanner.ts:135–145`, `src/docker/compose.ts:29–42`, `src/core/detectors/docker.ts:16–24`, `src/core/generator.ts:65–73`.

**Problem:** Spinup prefers `docker-compose.yml` when actual Compose prefers `compose.yaml`. Generated commands omit the detected file selection. Static parsing misses effective overrides/includes/profiles/conditions. Mixed projects launch one Compose invocation per detected service, potentially overlapping dependencies and enabling optional profiled services.

**Recommended fix:** Use Compose as the authority. Resolve effective configuration with `docker compose config --format json` or a narrower supported query, retaining the exact cwd, file and profile selection for execution. Do not log resolved configuration containing secrets. When Compose is unavailable, clearly label static detection as incomplete instead of claiming full resolution.

Generate one Compose invocation for the selected container application, not one supervisor process per container. Respect project names and any explicitly selected files/profiles. Let Compose handle dependency conditions and lifecycle. Keep the updated YAML parser with `merge: true` only where limited static parsing is still needed.

Use ordinary attached `up` when its lifecycle matches the task. Evaluate `up --wait --wait-timeout` only for an explicitly required detached readiness step. That mode implies detached operation and needs a stated ownership/cleanup policy. Do not run `down`, especially `down -v`, as blanket failure cleanup or stop resources that predated Spinup. Coordinate native dependencies with F10 rather than adding fixed sleeps.

**Acceptance:** Detection and execution agree with Compose on competing filenames, multiple files, overrides, includes, profiles and health conditions. Optional services stay optional. One component owns container lifecycle. Tests of config resolution must not start containers. Add isolated live lifecycle checks only when explicitly configured for them, and report whether they ran.

## 7. Distribution and documentation

### F21. CI coverage does not establish every advertised platform

**Priority:** P1. **Status:** partial. **Evidence:** source-confirmed.

**Location:** `.github/workflows/ci.yml`, `.github/workflows/release.yml:18–73`, `tsconfig.json:13`.

**Problem:** CI gates exist and Bun is pinned, but binaries are cross-built on Ubuntu without native macOS/ARM execution. Tests are not typechecked. Artifact and publishing actions retain mutable version tags.

**Recommended fix:** Extend the current workflows rather than adding a second system. Typecheck tests using an appropriate test tsconfig and Bun type definitions if needed. Keep the existing runner. Pin remaining actions to reviewed immutable revisions and retain read-only defaults with publishing permissions scoped to the required job.

Execute the produced binaries on native runners for each advertised OS/architecture. Verify runner architecture rather than assuming a label. At minimum exercise version, registration, a harmless launch, failure exit status and cleanup. Run tmux/permission/migration cases where relevant, including case-insensitive migration on macOS. Missing execution evidence must be recorded as such, not replaced by a successful cross-compile.

**Acceptance:** A failing regression blocks publication. Source and tests typecheck. All published supported targets have native smoke results tied to the build revision/runtime, or their support claims are explicitly narrowed. Validate release-version/tag agreement before publication.

### F22. Installer verification and replacement are incomplete

**Priority:** P1. **Status:** partial. **Evidence:** source-confirmed, with missing-argument behavior reproduced.

**Location:** `install.sh:25–35,90–106`, `scripts/build-release.sh`, `.github/workflows/release.yml`.

**Problem:** ARM64 is now in the matrix, but downloads have no published-digest/provenance verification. System-temp staging can make replacement non-atomic across filesystems. libc compatibility is unchecked. Missing option arguments fail without an explanation.

**Recommended fix:** Publish a checksum manifest and verify the selected asset before installation or execution. Use available platform checksum tools and fail clearly if verification cannot run. Download/stage the final replacement on the destination filesystem, check every operation and rename only after successful verification. Preserve the old executable on failure.

Validate option values and supported platform combinations before downloads. Either support musl explicitly with tested assets or reject it clearly. Handle historical asset names for supported old release pins, or explicitly reject pre-rename versions. Do not construct a Spinup asset URL for an old RUNIT-only release and call that supported installation.

A checksum fetched from the same release protects against corruption and mismatches, not a compromised release publisher. Add and verify signed provenance if stronger authenticity is part of the distribution contract. Test actual macOS installation/Gatekeeper behavior before claiming that route is dependable.

**Acceptance:** Wrong checksum, truncated download, missing asset, unsupported platform, invalid option and interrupted replacement leave the previous executable intact and report failure. Exercise checksum verification on Linux and macOS and verify that the installer requests only assets actually produced by the release matrix.

### F23. Documentation and remediation claims are inaccurate

**Priority:** P2, with safety-contract corrections shipped alongside their fixes. **Status:** partial. **Evidence:** source-confirmed.

**Location:** `README.md:19–22,24–40,474`, `CHANGELOG.md`, `RUNIT_REVIEW.md:646–670`.

**Problem:** Licensing and renaming are done, but README says “Renamed from spinup” and describes the wrong legacy filename in that paragraph. Configuration examples and operational contracts remain incomplete. The remediation table marks several partial fixes complete and reports an outdated test count.

**Recommended fix:** Document actual behavior after its tests pass. Correct the RUNIT-to-Spinup migration, legacy paths, version/platform support and upgrade procedure. Provide working simple, multi-window and mixed-project examples. Explain command trust, action selection, shell execution, stdin, signals, dependencies versus readiness, delays, environment precedence, ownership and regeneration replacement/backup behavior.

Update the remediation ledger with exact scope and evidence. Preserve historical audit text as historical evidence rather than rewriting old observations to look like current behavior. Do not claim zero secret disclosure, complete orphan cleanup or full migration until the corresponding failure-path checks pass. Do not reopen the chosen name/license or expand into unrelated documentation cleanup.

**Acceptance:** Each documented command/config example is exercised. README, help, changelog and support matrix agree with the implementation. Every closed finding cites the regression or native execution evidence that satisfies its full scope.

## 8. Verified fixes to preserve

### F04. Compiled caller-directory dotenv isolation

**Status:** verified fixed for the compiled path.

Keep `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` in every release build path. Keep a behavioral binary test, not only a source-text assertion: register project A, place a dummy dotenv value in caller directory B, start A from B, and prove the child ran without receiving B's value. F15 separately addresses explicit loading and source-mode policy.

### F07. Commands execute as written

**Status:** verified fixed for the reported command-semantic bug.

Do not prepend `exec` to arbitrary shell programs. Preserve full compound commands, inline assignments, pipelines, multiline programs and quoted paths while fixing lifecycle ownership separately. Internally generated structured commands can use explicit argv where supported. Keep regressions for `printf FIRST && printf SECOND`, an inline assignment and a pipeline in both applicable backends.

### F20. YAML dependency advisories

**Status:** verified fixed for the locked advisories.

Keep the updated `yaml` dependency and removal of `js-yaml`. Retain `bun audit` as a gate and Compose anchor/merge regressions. Do not replace `YAML.parse(raw, { merge: true })` with default parsing where Compose merge semantics are required. Malformed input should fail clearly within bounded resources. Do not upgrade unrelated dependencies as part of this item without a separate reason.

## 9. Regression and release gates

These gates extend the original report's G01–G06 identifiers. Add focused checks to the existing suite as implementation proceeds. Temporary review probes are reproduction aids, not a substitute for committed regression tests.

| Gate | Required evidence |
|---|---|
| G01 | F01/R1: invalid aliases, foreign entries, symlinks and concurrent shim creation cannot clobber unrelated files. |
| G02 | F02/R2: repeated launch preserves owned work, and exact-name/prefix/unowned collisions never destroy sessions. |
| G03 | F03/F04/F15: dummy secrets are absent from tool-generated terminal/errors, compiled caller dotenv is isolated and effective env is backend-consistent. |
| G04 | F05/R6/F06: no-op editing preserves bytes, cross-window edits preserve intent, and every destructive regeneration has a truthful preview and private recovery copy. |
| G05 | F07/F08/R3: command semantics survive, failures are prompt, exit statuses are meaningful and cancellation leaves no owned descendants. |
| G06 | F20: the dependency audit is clean and YAML malformed/merge fixtures still pass. |
| G07 | F09/F10/F11/F16/F17/F18: streaming is bounded, supported dependency conditions work, terminal edge cases are explicit, and validation/inspection match the selected launch. |
| G08 | F19/R4/R7: concurrent/interrupted operations are recoverable, real legacy wrappers migrate, and file permissions are never unintentionally widened. |
| G09 | F12/F13/F14: the discovery matrix produces validated configs from authoritative commands with unique identities and Compose-equivalent selection. |
| G10 | F21/F22/F23: release gating, native target execution, verified atomic installation and documentation all agree. |

**Safety of the tests:** Isolate `HOME`, `XDG_CONFIG_HOME`, shim paths and tmux sockets. Test signal handling in a separate process so it cannot terminate the test runner. Signal only fixture-owned groups and always clean up in `finally`. Use dummy credentials. Do not enumerate or kill the developer's tmux server. Do not start real project services, download/install toolchains or delete containers/volumes merely to make a test pass.

**Completion report required from the implementing agent:** For each finding, state fixed/partial/deferred, the exact tests run, any platform gaps and any changed compatibility contract. Report results for `bun run check`, `bun test`, `bun audit`, shell syntax, ShellCheck when available, and the compiled smoke tests. A regression must fail against the affected implementation and pass against the fix. Do not report this whole handoff complete while F10's design/evidence or native-platform gates remain deferred.

## 10. Evidence and research available to the next agent

This file is self-contained about observed failures and acceptance requirements. Local artifacts may disappear and are not needed to understand the plan.

| Evidence | Location in the review environment |
|---|---|
| Baseline revision, suite and audit | `/tmp/spinup-recheck-2htvi9ry/revision.json`, `tests.log`, `audit.log` |
| Legacy upgrade, exact-session destruction, SIGTERM, exit code and compiled dotenv | `/tmp/spinup-recheck-2htvi9ry/reproduce.py`, `reproductions.json` |
| Regeneration, rejected-alias writes, diagnostics, readiness, stdin, editor and stale tmux env | `/tmp/spinup-recheck-2htvi9ry/cli-probes.py`, `cli-probes.json` |
| Shim link and cross-window editor probes | `/tmp/spinup-recheck-2htvi9ry/repo/review-probes.ts`, `review-probes.jsonl` |
| Detection, validation, comparison, permissions and long aliases | `/tmp/spinup-recheck-2htvi9ry/repo/audit-probes.ts`, `audit-probes.json` |
| tmux layout/index and secret-error probes | `/tmp/spinup-recheck-2htvi9ry/repo/tmux-probes.ts`, `tmux-probes.json` |

`RUNIT_REVIEW.md` section 9 contains upstream references. Relevant groups include S01 for Bun compilation, S02/S03/S27 for Execa/process execution, S04 for tmux, S05–S08 for Compose, S09 for YAML editing, S10 for Process Compose, S14–S18 for project environments/workspaces/XDG, and S20–S21 for CI and provenance. Retrieve current version-specific documentation before depending on an API or selecting runner labels. These references establish feasibility, not a tested integration.

**Bottom line:** Repair ownership, preservation and execution semantics using the current stack. Keep proven fixes, make each remaining failure reproducible in CI, and delegate orchestration where an existing project tool already implements the required behavior.
