# Changelog

English | [中文](CHANGELOG.md)

Notable changes to `dsh-jev-tools`, in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format, with versions following [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This project is pre-1.0: a minor version may contain a breaking change, and the
`Removed`/`Changed` sections below will say so when it does.

## Version status

| Version | Date | State | Summary |
|---|---|---|---|
| `0.1.10` | 2026-09-25 | **published** | The ledger records baseline coverage; a net gain is no longer reported without a measured baseline. |
| `0.1.9` | 2026-09-25 | **published** | An injected notice used to fail the whole turn; the source kind now names its producer, as format v4 requires. |
| `0.1.8` | 2026-09-22 | **published** | Skill suggestion had **never fired**, now fixed; the two tools' quota and refusal reasons are no longer dead or silent. |
| `0.1.7` | 2026-09-22 | **published** | Structural failures are no longer silent; cost is visible; calibration gains AUC and a threshold sweep; CI and tag-driven releases. |
| `0.1.6` | 2026-09-22 | **published** | The judgment endpoint is configurable (`baseUrl`); `/jev-status` reports it. |
| `0.1.5` | 2026-09-21 | **published** | Fixes the Workshop manifest's adapter field; the capabilities are the same as `0.1.4`. |
| `0.1.4` | 2026-09-21 | **published** | Adds the OMDSH Workshop manifest; the capabilities are the same as `0.1.3`. |
| `0.1.3` | 2026-09-21 | **published** | README rewrite; the capabilities are the same as `0.1.2`. |
| `0.1.2` | 2026-09-21 | **published** | Source installs work; the capabilities are the same as `0.1.1`. |
| `0.1.1` | 2026-09-21 | **published** | Documentation corrections; the capabilities are the same as `0.1.0`. |
| `0.1.0` | 2026-09-20 | **published** | The first release, containing everything described below. |

Published on npm: `npm i dsh-jev-tools`. It can also be installed from the repository checkout.

## [0.1.10] — 2026-09-25

### Added

- **Baseline coverage in the ledger.** Every prune judgment now records whether the deterministic
  baseline was really measured: content answers are stored as `baselineKeptTokens`; a `null` answer
  (the payload is inside DSH's own budget) is stored as the **full original token count** — a
  measurement that the baseline removes nothing, not missing data; an absent service or a thrown
  call is stored as `baselineUnavailable: no-service | error`. The totals gain `baselineMeasured`
  and `baselineUnmeasured`. Evidence: on 2026-09-25 two prune judgments were indistinguishable in
  the old ledger — a headless composition measured `baselineKeptTokens: 4441.5`, while a web
  composition recorded `no-service` (the Web surface mounts the deterministic pruner behind an
  agent preset).

### Changed

- **A net gain is no longer reported without a baseline.** `/jev-status` prints the coverage next
  to the increment, and with `baselineMeasured` at 0 it reports only the removal and says the net
  gain has no data. The old totals computed `baselineKept = entry.baselineKeptTokens ?? original`,
  which read "never measured" as "the baseline removes nothing" — making the net gain equal to
  everything the plugin removed: an assumption, not a result.
- Two README statements are now accurate: pruning keeps **scattered relevant segments** rather than
  cutting one contiguous middle block, and the net increment is stated with its coverage premise.

## [0.1.9] — 2026-09-25

### Fixed

- **An injected notice failed the whole turn.** Since 0.1.7 the harness writes sessions in format
  v4, which has **no shared `plugin` source kind**: each message states **who** produced it, and the
  retired `{ kind: 'plugin', plugin: … }` wrapper is refused by the writer — it does not drop that
  one message, it ends the turn with `format v4 message requires a producer-owned source kind`
  ("this turn failed" in the UI). All four notice lines hit it: `prune`, `screen`, `suggest`, and
  the degrade notice. Evidence: on 2026-09-24 two sessions stopped mid-step at the exact moment a
  notice was injected — `f87f8e58` at its prune judgment (23:55:53, 5376 → 3187 tokens) and
  `5f45b2e2` at its screen judgment (23:56:51) — the log ends on `tool/call` with no `turn/end`;
  reproducing it with the harness 0.1.7-rc.1 `assertV4MessageSources`: `kind: 'plugin'` throws,
  `kind: 'plugin:dsh-jev-tools'` passes.

### Changed

- **One module owns the notice source.** `src/source.ts` builds it for every capability, and the
  kind it writes — `plugin:dsh-jev-tools` — is the identity the harness's own v3→v4 migration
  records for this plugin's historical notices, so notices written before the upgrade and notices
  written today stay under one kind instead of splitting in two.

## [0.1.8] — 2026-09-22

### Fixed

- **Skill suggestion had never fired.** The only defect here where **a whole capability did nothing and
  nothing outside could tell.** `skills.list()` passed no `scope`, and the registry reads the **global
  layer alone** when `scope` is omitted — while a plugin mounted by an agent preset registers into that
  **preset's layer**. A session holding twenty-odd skills was therefore invisible to the plugin, the
  catalog stayed under the 15 floor, and every turn returned silently. Evidence: before the fix,
  **227 ledger rows across 6 sessions contained not one `suggest` row**, against 218 for `prune` and 9
  for `screen`; after it, the first `judged` row appeared and a suggestion reached the session.
- **`jev_ask` / `jev_gate` could be called three times per session.** Both called
  `budget.tryConsume(agentId, -1)`: `-1` is a **pseudo-turn that never advances**, and the ceiling passed
  in is `prune.perTurnLimit` — a per-turn value — so `turns.get(-1)` only ever grew. The fourth call
  onwards was refused **permanently**. Measured: three successes, then three `skip: "budget-turn"` rows.
  Explicit calls now take a separate `tryConsumeSession()` bounded only by `sessionCallLimit`: the
  per-turn ceiling exists to bound the latency an **automatic** capability adds, which has no rationale
  for a call that is asking for one answer.
- **A refusal reached the session as a placeholder.** The renderer reads only `report`, and `declined()`
  returned `{ problem, message, detail }` without it — so a missing key, an invalid request, an exhausted
  quota and a network failure were indistinguishable in the session: `(no judgment)` (and
  `(no gate verdict)` for the gate). That contradicts what the README promises — the price of fail-open
  is that these failures are visible **only** in the session.
- **Refusal rows lost the session id.** The failure path hardcoded `agentId: ''` while the success path
  recorded the real one, so half of a tool's ledger could not be attributed.
- **The refusal text named the wrong ceiling.** It claimed "this session allows at most 200", while the
  check actually performed was the per-turn one. The text now describes the ceiling that stopped it.
- **An abstention re-judged on every later step of the same turn.** The turn was latched only once a
  notice was actually produced, so an abstention — the normal outcome on a vague turn — latched nothing
  and every subsequent step re-sent the judgment. Measured: **three user turns produced four judgment
  rows**, each spending the per-turn allowance `prune` shares. The latch is now set before the request
  goes out, and the latch hit writes no row: **one `suggest` row per turn** is the invariant.

### Added

- **Every skill-suggestion decline is now recorded.** Three skip reasons are added: `no-skills`,
  `catalog-unavailable`, `catalog-too-small`. Until now all eight early returns were silent, so "never
  ran" and "ran and declined every time" were **indistinguishable from outside** — the one question the
  ledger exists to answer. Rows are deduplicated by (turn, reason): `agent/pre-step` fires on every step,
  and without that the same line would flush the 1000-row ledger window.
- **Skill suggestion now judges the latest user message** (falling back to the last three when it is too
  short). That is a **semantic** choice, not an accuracy gain: a suggestion answers "what is being asked
  now", while a three-message window answers "what is this session doing" — pruning's question. A
  controlled rerun (same criteria, only the task text changed) showed the window merely **diluting** the
  distribution: winner 0.510 → 0.470, top-two margin 0.24 → 0.16, **winner unchanged**.

### Changed

- The README's quota wording is now accurate: `sessionCallLimit` names both tools, and
  `prune.perTurnLimit` says it is **shared by prune, screen and suggest**. The data-boundary table gains
  `jev_ask` and `jev_gate` — both send caller-supplied text off the machine, and the section had omitted
  them.
- The poster and its render script moved out of `docs/` (to `poster/` at the repository root): the
  `files` allowlist covers all of `docs/`, and 3 MB of marketing artwork has no reason to reach every
  `npm i`.

## [0.1.7] — 2026-09-22

### Added

- **Structural failures are no longer silent.** With no key configured, or a key the endpoint refuses
  (401), the plugin says so **once in the session** — once per session, per reason, de-duplicated
  through the session history. Fail-open is the right rule (a failed judgment must not fail the task),
  and its price is that neither failure is reported anywhere else: a mistyped `baseUrl` or a key issued
  for a different host looks exactly like a plugin doing nothing. The notice reaches the model as well
  as the reader, so a model stops trusting a pruning layer that has gone blind.
- **Spend is visible.** The ledger gains a cumulative input-token counter (input is billed, output is
  free), and both `/jev-status` and `npm run measure -- --ledger` show it in dollars at `$0.042` per
  million. Until now `estimateCostUsd()` had no caller outside its unit test, and the measurement script
  carried its own second copy of the price.
- **The calibration report gains AUC and a threshold sweep.** `npm run measure -- samples.jsonl` now
  answers two questions it did not before: ROC AUC (can the model separate the classes at all — a
  different question from whether it is calibrated) and a 0.05–0.95 threshold table with
  precision/recall/F1 and the best operating point. That is the number a gate needs, and it complements
  the existing ECE/Brier.
- **CI and release automation.** `.github/workflows/ci.yml` (ubuntu + windows × node 24: `npm ci` →
  `npm test` → tarball check) and `.github/workflows/release.yml` (a **tag is the only thing that
  publishes**: the tag is checked against the version in `package.json`, the same gates run, and the
  publish goes through npm trusted publishing with no long-lived token). Together with
  `scripts/check-tarball.mjs`, which asserts the published tarball carries no local state
  (`.npm-cache/`, `trigger-rate.json`, …) and is not missing anything a consumer needs — an allowlist is
  a control only for as long as nobody widens it.

### Changed

- The judgment price is declared once (`USD_PER_MTOK` in `src/request.ts`); the measurement script no
  longer keeps its own copy.

## [0.1.6] — 2026-09-22

### Added

- **The judgment endpoint is configurable** (`baseUrl`, default `https://api.typesafe.ai`). The change is
  small because it fixes a **declared-but-never-wired** gap: `JevBackendOptions.baseUrl` already existed
  and `createJevBackend` already read its address from it, but `JevSettings` had no such field, so the
  settings page offered no way to set one and the three construction points in `apply()` had nothing to
  pass — the pipeline could only ever reach the default host. A hardcoded endpoint is what blocks
  **self-hosted Jev-compatible servers** and deployments that put **a gateway in front**. The value now
  travels from the settings (or the bundle row's `config:`) into all three backend construction points;
  give it a bare host and the plugin still appends `/v1/systemone`. Like the key, the endpoint is read
  per operation, so a change needs no restart.
- **`/jev-status` gains a "Judgment endpoint" line.** With the endpoint configurable, where the content
  goes stops being a constant — and a wrong one looks exactly like a plugin doing nothing. That report is
  the one place built to answer that question.

### Changed

- The default endpoint is now declared in exactly one place (`src/config.ts`) and imported by the
  backend instead of being held twice, so the setting's default and the backend's fallback cannot drift
  into two different hosts.

## [0.1.5] — 2026-09-21

### Fixed

- `dshWorkshop.install.adapter` changed from `harness-cordis` to `third-party`: the OMDSH Workshop protocol mapping pairs `harness-cordis` with the `third-party` adapter, and using the protocol name as the adapter is rejected by its validator.

## [0.1.4] — 2026-09-21

### Added

- `package.json` gains a `dshWorkshop` manifest (`omdsh-workshop-package/v1`) declaring the integration protocol, install mode, lifecycle, structured permissions, compatible releases, and one observable capability, for the intake of [OMDSH Hub](https://github.com/omdsh-dev/dsh-hub-workshop). It is metadata for the catalog and changes no behaviour inside DSH.

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
- **Test coverage at every seam**: the pruning pipeline and every skip guard,
  the retry/backoff matrix, request validation, credentials policy, ledger
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
