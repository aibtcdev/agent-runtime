# Lumen Context Authority Plan

This document is the operator runbook for the next stage after the proving deployment.

It does not authorize external account creation or repo writes by itself. Every irreversible action below has an explicit checkpoint.

## What Exists Now

- real host proving runtime is live on `dev@192.168.1.16`
- config is `deploy/lumen/runtime.lumen.json`
- `agent-runtime-operator@lumen.service` is active
- `agent-runtime-dispatch@lumen.timer` is active
- manual `github-story` and `discord-reply` proving paths passed
- Hermes remains intact beside Lumen
- current live scope is still narrow and bridge-oriented

## What Needs To Be Built

Stage 1 - Observe And Normalize

- recurring repo/doc review on the existing 5-minute loop
- managed repo context packs with provenance and freshness
- managed change digests
- managed authority snapshot

Stage 2 - Drift And Queue

- docs drift reports
- wiki refresh source artifacts
- open update queue derived from stale or missing context

Stage 3 - Authority Answers

- operator and peer-agent answers grounded in the latest authority snapshot and repo context packs

Stage 4 - Managed Sync

- supervised docs/wiki updates
- supervised signed git operations using Lumen identity

## Canonical Artifacts

Lumen should own these paths under `deploy/lumen/state/artifacts/`:

- `context/aibtc/repo-index/latest.json`
- `context/aibtc/repos/<repo-slug>/latest.json`
- `context/aibtc/change-digests/<yyyy-mm-dd>/<tick-id>.md`
- `context/aibtc/docs-drift/<yyyy-mm-dd>/<tick-id>.json`
- `context/aibtc/wiki-refresh/<repo-slug>/<tick-id>.md`
- `context/aibtc/authority-snapshot/latest.json`
- `context/aibtc/open-update-queue/latest.json`

Every artifact should include:

- `artifact_type`
- `artifact_version`
- `generated_at`
- `source_tick`
- `repos_considered`
- `source_refs`
- `freshness_window_minutes`

## Implementation Phases

Phase A - Approve The Contract

- review `proposals/0006-lumen-context-authority.md`
- review this runbook
- approve the first implementation slice as read-only artifact generation

Checkpoint:

- operator confirms Stage 1 may proceed without external identity actions

Phase B - Add The First Authority Loop

- add one workflow template for recurring repo/doc review
- add one authority task contract
- add repo target and freshness fields to prompt/bundle inputs
- write `repo-index` and per-repo context packs

Checkpoint:

- operator confirms the first live authority loop is still read-only and limited to a declared repo subset

Phase C - Add Drift And Queue

- add docs drift artifact
- add open update queue artifact
- add dashboard visibility for freshness and pending updates

Checkpoint:

- operator confirms the queue output is useful before any docs/wiki write path is built

Phase D - Bootstrap Identity

- create durable email
- create dedicated GitHub account
- authenticate `gh` on the host
- add signing key and git identity

Checkpoint:

- operator approves each irreversible identity action separately

Phase E - Enable Supervised Repo Writes

- restrict write scope to one repo at a time
- require signed commits/tags
- keep repo writes supervised until authority artifacts have been stable on-host

Checkpoint:

- operator explicitly enables repo-write scope after Stage B and Stage C are observed

## Runtime And Workflow Changes Needed

In repo:

- authority workflow template for recurring repo review
- authority task kind or bounded goal-loop contract for repo review
- prompt contract for repo targets, doc roots, and freshness windows
- bundle fields for declared repo-review targets and local mirror refs
- artifact writer support for structured authority artifacts
- dashboard/report surfacing for latest authority snapshot age and update queue size

Not in repo:

- email mailbox setup
- GitHub account creation and 2FA enrollment
- org membership and repo permission assignment
- signing-key upload to GitHub
- host `gh` authentication using Lumen credentials

## Identity Bootstrap

### Email

Recommended durable mailbox:

- `lumen@aibtc.dev`

Acceptable fallback:

- any dedicated mailbox reserved only for Lumen and not shared with Hermes or a human operator

Signer:

- `arc0btc`, using the existing operator-controlled signing identity already trusted for AIBTC coordination

Exact signed message text:

> I, arc0btc, authorize creation of a dedicated mailbox for the Lumen agent runtime. The requested mailbox is `lumen@aibtc.dev` or the closest available dedicated equivalent reserved solely for Lumen. This mailbox is to be used for Lumen's durable operator identity, GitHub account bootstrap, commit-signing contact metadata, recovery flows, and supervised runtime operations. It must not be reused for Hermes or any human operator identity. Requested on 2026-04-21 for Proposal 0006 bootstrap.

Operator checkpoint before sending:

- confirm the mailbox name
- confirm who will administer the mailbox
- confirm recovery ownership and retention policy

### GitHub Account

Recommended account name order:

1. `aibtc-lumen`
2. `lumen-aibtc`
3. another dedicated Lumen-only name agreed by the operator

Exact bootstrap sequence:

1. Create the mailbox first.
2. Create the GitHub personal account with that mailbox.
3. Enable 2FA immediately.
4. Store the TOTP seed and recovery codes in the Arc credential store, not in repo files.
5. Add the account to the `aibtcdev` org with least privilege:
   - read on all relevant AIBTC repos needed for review
   - write only on `agent-runtime` and the designated docs/wiki repo when supervised writes are approved
   - no admin permissions
6. Add the signing public key to the GitHub account as a signing key.
7. Authenticate `gh` on the host using Lumen credentials.

Initial repo access scope:

- read: all AIBTC repos Lumen must review
- write: `agent-runtime` only at first
- later write: one designated docs/wiki repo after Stage C is observed

### `gh` Authentication

Use the Arc encrypted credential workflow for secret storage:

- store file: `~/.aibtc/credentials.enc`
- password source: `~/arc0btc/.arc-secrets`
- password variable: `ARC_CREDS_PASSWORD`

Store these names in Arc:

- `github:lumen_fine_grained_pat`
- `github:lumen_totp_seed`
- `github:lumen_recovery_codes`

Recommended host auth sequence:

1. Install `gh` on the host if missing.
2. Materialize a temporary `GH_TOKEN` in the shell from the Arc credential store.
3. Authenticate and verify:

```bash
export GH_TOKEN='<lumen fine-grained token from Arc>'
gh auth status --hostname github.com || gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git --hostname github.com
gh auth status --active --hostname github.com
unset GH_TOKEN
```

Notes:

- For headless use with a fine-grained token, prefer `GH_TOKEN` over `gh auth login --with-token`.
- If the operator chooses a classic token for bootstrap only, `gh auth login --with-token` is acceptable, but the long-term preference is a fine-grained token with explicit repo scope.

