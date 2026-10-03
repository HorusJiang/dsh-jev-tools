# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| latest (0.1.x) | ✅ |
| anything older | ❌ |

This names the release line, not a patch: whatever `package.json` declares is the
supported one. If the two ever disagree, `package.json` is the source of truth.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's private
reporting instead:

- [Open a private security advisory](https://github.com/HorusJiang/dsh-jev-tools/security/advisories/new)

Include what you can: the impact, the smallest reproduction you have, and the version
you saw it on. Acknowledgement is intended within 3 business days, with a fix in the
next patch release.

## What this plugin sends where

This is the most useful thing a reporter can check, so it is written out rather than
summarised. Everything below is the current behaviour; the README's
「数据边界」/ "Data boundary" section is the user-facing version of the same table.

| Stays on the machine | Sent to the configured judgment endpoint (default `api.typesafe.ai`) |
|---|---|
| The API key's literal value — only ever an `Authorization` header, never logged, never echoed | That key's value, as that header, for that request only |
| The judgment ledger under `$DSH_HOME/storages/dsh_jev_tools/` | — |
| Session logs, conversation history, file paths, and every tool result that was **not** selected for judgment | — |
| — | **The body of a tool result selected for pruning**, plus the current task text |
| — | Injection screening: **the fetched page body**, plus the current task text |
| — | Skill suggestion: the current task text, plus skill names and descriptions |
| — | `jev_ask`'s `state`, and the question text you give it |
| — | `jev_gate`'s `request` / `claims` / `evidence` / `artifact` |

**With the plugin enabled, tool output and fetched pages leave the machine.** The
destination is whatever `baseUrl` resolves to. With no key configured the plugin is
completely inert and makes **no network request at all**.

## How the key is handled

- **There is no file-based key store.** The key is read through the DSH credentials
  service, or from an environment variable named by the `apiKeyEnv` setting (default
  `TYPESAFE_API_KEY`), resolved per operation and never cached. Nothing writes it to disk
  from this plugin — which is why this repository has no `config.json` and needs no file
  permission story, unlike a plugin that keeps a key in a JSON file.
- The key is **never echoed**: `/jev-status` prints the variable **name** and the
  **source** it was resolved from, never the value. It is never written to the ledger,
  which records metadata only (timings, token and chunk counts, the answering model
  version, skip reasons, a session identifier).
- Failure modes are the point, so they are stated: pruning and screening **fail open**
  (a judgment that cannot be read leaves the content exactly as it was — a broken
  judgment must not fail a task). `jev_gate` is the deliberate exception and **fails
  closed**: every ambiguous path — an unreadable answer, a claim the evidence
  contradicts, truncated input, a backend failure — escalates rather than passing,
  because "failed to closed" dressed up as "passed" is the one unacceptable outcome.

## In scope

- Any way to make the key appear in a session, a log, the ledger, or a network request
  to a host other than the configured `baseUrl`.
- Prompt-injection **bypass**: content that the screening step should flag but does not,
  or a path where screening is skipped for content it is supposed to cover.
- A path where `jev_gate` can return a passing verdict without evidence supporting every
  claim — especially anything that turns a backend or parsing failure into a pass.
- Anything that lets a fetched page cause the plugin to act, rather than be treated as
  data.

## Out of scope

- The accuracy of a judgment. It is a small decision model: probabilities are for
  ranking, not for calibration, and the README's 「已知局限」/ "Known limits" section
  says so. A wrong-but-honest judgment is a quality issue, not a vulnerability.
- A key that leaked because the user pasted it into a channel they do not control, or
  because the machine it was configured on was already compromised.
- Availability of the vendor's endpoint (`api.typesafe.ai`) or of any third-party
  System One host you point `baseUrl` at.
- The main model's own behaviour. This plugin returns judgments; what the harness does
  with them is outside it.
