# Changelog

English | [中文](CHANGELOG.md)

Notable changes to `dsh-jev-tools`, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format, with versions following [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This project is pre-1.0: a minor version may contain a breaking change, and the
`Removed`/`Changed` sections below will say so when it does.

## Version status

| Version | Date | State | Summary |
|---|---|---|---|
| `0.1.3` | 2026-09-21 | **published** | README rewrite; the capabilities are the same as `0.1.2`. |
| `0.1.2` | 2026-09-21 | **published** | Source installs work; the capabilities are the same as `0.1.1`. |
| `0.1.1` | 2026-09-21 | **published** | Documentation corrections; the capabilities are the same as `0.1.0`. |
| `0.1.0` | 2026-09-20 | **published** | The first release, containing everything described below. |

Published on npm: `npm i dsh-jev-tools`. It can also be installed from the repository checkout.

## [0.1.3] — 2026-09-21

### Changed

- Rewrote the README into a shorter structure: capabilities, install, configuration, data boundary,
  settings, troubleshooting, known limitations, ledger, development. The long tutorial-style
  introduction to Jev and the roadmap section are gone; no key fact was dropped.

### Fixed

- The header comment in `cordis.patch.yml` listed only some of the capabilities; it now lists all
  of them.

## [0.1.2] — 2026-09-21

### Fixed

- Installing from the GitHub source now builds automatically: `package.json` gained a `prepare`
  script. Before this a source install succeeded, but `lib/` is a build output and is not in the
  repository, so there was no entry file to load. Installing from npm is unaffected.

## [0.1.1] — 2026-09-21

### Fixed

- The README and CHANGELOG statements about release status now match reality (they previously
  said "not published"), and the README gained npm-version and license badges.
- The stale "only two capabilities" wording in the README now states the capabilities that
  actually ship.

## [0.1.0] — 2026-09-20

### Added

- **Semantic pruning of oversized tool results** (`tools/post-execute`), for
  `read` / `grep` / `glob` / `web_fetch` / `web_search`. Jev judges each segment
  for relevance to the current request and drops the irrelevant ones, leaving a
  visible notice. It **ranks rather than thresholds**, keeps deterministic
  head/tail floors, and is **pure fail-open**. Measured on the real API:
  `read: 4613 → 2624 tokens`.
- **Shadow mode** (`prune.shadow`): judge and record as normal, then change
  nothing — each payload reports what pruning *would* have removed. It exists so
  the trade-off can be inspected before it is trusted, and its records are
  excluded from the saved-token totals because nothing was saved.
- **Injection screening** for fetched content (`web_fetch` / `web_search`):
  judges the probability that a page carries instructions addressed to an AI and
  attaches a warning. **Advisory only** — it never blocks a call and never
  rewrites content. It runs below the pruning floor, because the most dangerous
  page is a short one, and it rides along in the pruning request when there is
  one to join.
- **Skill suggestion** (`agent/pre-step`): at most one suggestion per turn,
  silent below the confidence floor, advisory in the strict sense — it never
  rejects a step.
- **`jev_ask`** — a model-facing tool for any typed question (`noul` / `choice` /
  `score`), with validation of every documented vendor limit before the content
  leaves the machine.
- **`jev_gate`** — a model-facing tool that checks a delivery before it is called
  done: one verdict per completion claim (`verified` / `contradicted` /
  `not_addressed`) against the evidence actually supplied, plus one action for
  the whole delivery (`auto` / `review` / `escalate`). This is the one capability
  that **inverts the plugin's fail-open rule**: every unclear path resolves to
  `escalate`, because failing open for a gate means failing to "approved".
- **Judgment ledger**, metadata only, with cumulative counters kept separately
  from the bounded record set so eviction cannot shrink them. Records what the
  deterministic baseline would have kept alongside what semantic selection kept,
  which makes the increment a measured number rather than an argument. Persisted
  through `storageDomain` when the profile provides it, in memory when it does
  not.
- **`/jev-status`** — enabled state, key source, judgment counts, ledger location,
  and the reason for every single skip.
- **Bilingual output** for everything a person reads: the settings card follows
  the DSH interface language, and session notices, `/jev-status` and tool reports
  follow the conversation.
- **Measurement tooling**: `scripts/trigger-rate.ts` (trigger rate from local
  session logs; no key, no network) and `scripts/measure.ts` (labelled-set
  calibration, or the ledger's own increment report).
- **192 tests**, covering the pruning pipeline and every skip guard, the
  retry/backoff matrix, request validation, credentials policy, ledger
  persistence and restart continuity, screening, the gate's decision matrix, and
  the architectural layering (which is enforced by a test rather than by
  convention).

### Defaults, and why

Every one of these came from a measurement over 72 real sessions and 4,653 real
tool results, not from a preference. `docs/s0-trigger-rate.md` holds the numbers.

| Setting | Default | Basis |
|---|---|---|
| `prune.minTokens` | `2000` | Latency is governed by the quota, not the threshold; of the oversized results, this keeps 31.9% of the available saving |
| `prune.perTurnLimit` | `3` | Uncapped, the worst turn added 8.1 s; capped at 3, 0.9 s |
| `prune.toolAllowlist` | `read` `grep` `glob` `web_fetch` `web_search` | Covers 76% of oversized results; **`pwsh` is deliberately absent** |
| `prune.headLines` / `tailLines` | `40` / `40` | Deterministic floors; not negotiable |
| `prune.keepHigh` | `0.5` | A segment this relevant is kept unconditionally |
| `prune.minKeepRatio` | `0.2` | Never reduce a result to a shell |
| `prune.minSaving` | `0.15` | Below this, the distortion is not worth the tokens |
| `prune.minTaskChars` | `12` | Judging relevance against "carry on" produces noise |
| `screen.minTokens` | `300` | Below this there is not enough text to carry an instruction |
| `screen.threshold` | `0.75` | Injection probability at which the warning is attached |
| `suggest.minCatalogSize` | `15` | Measured catalog: min 27, median 29 |
| `suggest.minConfidence` | `0.3` | Below this, no suggestion is injected at all |
| `sessionCallLimit` | `200` | The hard ceiling on both cost and content leaving the machine |

### Known limitations

- **No accuracy figure exists.** The only quality evidence is 8/8 on an 8-item
  self-authored Chinese three-way set, and **no comparison against the host model
  was ever run**. The project's own plan asked for that comparison and it was not
  done.
- **Probabilities are not calibrated.** Measured: they saturate at `1.000` on easy
  inputs and run under-confident on hard ones. Rank with them; never read them as
  an accuracy figure, and do not gate on a fixed confidence threshold in the easy
  regime.
- **Calibration is a ready layer, not a working loop.** `src/calibrate.ts` has no
  runtime caller: fitting a curve needs a probability and a later observable
  outcome per judgment, and `noul` answers carry no confidence field while
  nothing reports whether a pruned segment turned out to be needed.
- **`/jev-status` and skill suggestion have never been observed in a live
  session.** Both have logic-level tests; neither has been seen working in the
  harness.
- **The completion gate is a judgment, not proof.** It runs no tests and applies
  no patch, it caps input (truncation forbids `auto`), and its field isolation is
  instruction-level only — a prompt injection inside a diff is mitigated by
  wording, not by a hard boundary.
- **Two harness processes sharing one storage root** make the cumulative counters
  last-write-wins; the domain facility's single-open guarantee is per process.

## Compatibility

| Subject | Requirement |
|---|---|
| DSH release | `0.1.6-alpha.2`, declared in `package.json` under `dsh.compatibility` |
| Node.js | `>= 20` (`engines`); developed and tested on 24 |
| Required DSH services | None. Every service is soft-injected, so a profile missing one still mounts the plugin and degrades visibly |
| Optional DSH services | `credentials`, `settings`, `tools`, `commands`, `skills`, `storageDomain`, `toolResultPruner` |
| Package dependencies | `@deepseek-ai/schemastery` only. DSH packages are optional peer dependencies: the published ones lag the deployment badly, so their types are deliberately not imported |
