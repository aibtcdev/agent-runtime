# Proposal 0006 - Lumen Context Authority

State: draft
Class: Standard
Current implementation status: target-only

## Problem Statement

Lumen is now live on the real host, but the live role is still a narrow proving role: GitHub story summaries and Discord replies. That is not sufficient for the target role the operator now wants.

The next stage is not "make Lumen more chatty." It is to make Lumen the authoritative AIBTC context agent:

- continuously review AIBTC repos and related docs on a short loop
- produce the freshest managed context artifacts about AIBTC code and operations
- keep docs, wiki inputs, and context packs aligned with code
- answer operators and peer agents from managed artifacts, not model memory

The current runtime already has the minimum substrate needed to start this safely: attempt rows, persisted bundles, managed artifacts, workflow evaluation, snapshots, reports, and a live 5-minute timer. What it does not yet have is a proposal-backed operating model for:

- which canonical artifacts Lumen owns
- which workflows maintain them
- how repo review, drift detection, and authority responses are grounded
- how Lumen's durable email, GitHub, and signing identities are staged without widening live write scope prematurely

Without that design, implementation would broaden the proving runtime ad hoc and make identity, artifact, and workflow decisions implicitly instead of audibly.

## Current Behavior

- `deploy/lumen/DEPLOY.md` now records a completed proving bring-up on the real host with `agent-runtime-operator@lumen.service` and `agent-runtime-dispatch@lumen.timer` active.
- `profiles/lumen/profile.json` still defines Lumen as an AIBTC community manager with bridge-only GitHub and Discord integrations, `allow_repo_changes: false`, and a summary-oriented result contract.
- `deploy/lumen/runtime.lumen.json` still frames the live runtime policy around GitHub story explanation and Discord-facing work, not multi-repo context authority.
- `src/context.ts` contains task-specific prompt narrowing for `github-story` and `discord-reply`, but no context-authority task contract for repo review, docs drift detection, or authority answers.
- `src/artifacts.ts` can write managed artifacts for output-path style tasks, but there is no canonical artifact taxonomy for repo context packs, change digests, docs drift reports, wiki refresh sources, authority snapshots, or update queues.
- `src/workflows.ts` contains `community-research`, `wallet-onboarding`, and `goal-loop` state machines, but no workflow template dedicated to recurring AIBTC repo review and artifact refresh.
- `src/context.ts` bundle compilation detects one execution workspace. It does not yet model declared repo-review targets, local mirrors, or freshness metadata for a multi-repo authority pass.
- No in-repo runbook yet defines Lumen's operator identity bootstrap, GitHub account bootstrap, `gh` authentication setup, or signed git posture.

## Proposed Change

Introduce the first authoritative-context tranche for Lumen as a staged rollout that keeps the live proving runtime intact while adding a new artifact-backed operating lane.

The rollout is explicit:

### Stage 0 - Identity And Access Bootstrap

Document, but do not execute automatically:

- Lumen email bootstrap
- Lumen GitHub account bootstrap
- `gh` host authentication
- signed git operations
- least-privilege credential storage via the Arc encrypted credential store

This stage is operator-gated. No external account creation, credential materialization, or irreversible identity action occurs without an explicit checkpoint.

### Stage 1 - Observe And Normalize

Add the first context-authority primitive:

- recurring review of declared AIBTC repos and related docs on the existing short dispatch loop
- production of managed artifacts that normalize current repo state, recent changes, and provenance
- no external writes yet

This stage is where Lumen stops answering from vague memory and starts answering from current managed evidence.

### Stage 2 - Drift Detection And Update Queue

Add artifact-backed detection for:

- docs drift between repo state and docs/wiki material
- stale context packs
- missing summaries or missing follow-up artifacts

This stage creates an explicit managed update queue instead of relying on operator memory.

### Stage 3 - Authority Responses

Make Lumen's operator and peer-agent answers read from the latest authority artifacts first, falling back to raw code/doc inspection only when the artifact set is stale or missing.

This is still read-oriented. It does not yet grant autonomous repo writes.

### Stage 4 - Managed Docs/Wiki Synchronization

Only after Stages 1-3 are proven:

- generate wiki refresh source artifacts
- open docs/update tasks or PR-ready artifacts
- optionally perform supervised repo writes under signed identity

This stage depends on the identity bootstrap and signing posture from Stage 0.

### Canonical Artifacts

Lumen should own these managed artifacts under the runtime artifact root:

1. `context/aibtc/repo-index/latest.json`
   - the declared repo set, local mirror paths if present, last reviewed timestamp, and freshness summary
2. `context/aibtc/repos/<repo-slug>/latest.json`
   - the current repo context pack for one repo: HEAD SHA, dirty/clean state, open PR/issue refs if collected, doc roots, and key findings
3. `context/aibtc/change-digests/<yyyy-mm-dd>/<tick-id>.md`
   - a human-readable digest of important code and doc changes since the last review
4. `context/aibtc/docs-drift/<yyyy-mm-dd>/<tick-id>.json`
   - machine-readable docs drift findings with severity and affected sources
5. `context/aibtc/wiki-refresh/<repo-slug>/<tick-id>.md`
   - a publishable source artifact for downstream docs/wiki refresh work
6. `context/aibtc/authority-snapshot/latest.json`
   - the condensed "what is true right now" artifact that other agents and operator surfaces should cite first
7. `context/aibtc/open-update-queue/latest.json`
   - the pending update/task queue created from stale artifacts, docs drift, and important code changes

Every authority artifact MUST include:

- `artifact_type`
- `artifact_version`
- `generated_at`
- `source_tick`
- `repos_considered`
- `source_refs` (commit SHAs, artifact refs, doc refs, or issue/PR refs)
- `freshness_window_minutes`

### Workflow Model

The first workflow set SHOULD be:

1. `aibtc-context-loop`
   - recurring repo/doc review and repo context pack refresh
2. `docs-drift-loop`
   - compares repo context packs against declared docs/wiki sources and emits drift artifacts
3. `authority-refresh-loop`
   - condenses repo packs plus drift results into the latest authority snapshot and open update queue

The initial implementation MAY land only `aibtc-context-loop` if that is the narrowest high-value slice.

### Profile And Answering Posture

Lumen SHOULD gain a context-authority operating profile, either by splitting `profiles/lumen/profile.json` or by adding a second Lumen profile for authority work. That profile should:

- prefer repo/doc evidence over narrative summaries
- allow artifact production
- remain no-external-post and no-autonomous-repo-write by default
- treat authority answers as citation-backed artifact synthesis

## What This Removes

- reliance on Lumen's prompt memory as an implicit source of AIBTC truth
- operator dependence on ad hoc repo inspection for every summary request
- unversioned, unnamed artifact sprawl for repo review outputs
- silent expansion from proving runtime into identity-bearing repo authority work
- the assumption that Discord or GitHub bridge outputs alone constitute durable context

## Invariants

1. Lumen authority claims MUST be grounded in fresh managed artifacts or explicitly marked stale.
2. The 5-minute dispatch loop remains the core scheduling primitive; new authority workflows build on it instead of bypassing it with a separate daemon.
3. No external account creation, `gh` login, signing-key registration, or credential write occurs without an operator checkpoint.
4. Stage 1 authority work MUST be read-oriented and artifact-producing only. Autonomous repo writes remain out of scope.
5. Canonical authority artifacts MUST be written under the managed runtime artifact root and pass existing artifact validation.
6. Every authority artifact MUST record provenance and freshness metadata.
7. Repo-review outputs MUST distinguish observed evidence from inference and list the repo refs they were derived from.
8. Lumen's GitHub and signing identity MUST be dedicated to Lumen and MUST NOT reuse Hermes credentials or operator personal identity as the long-term steady state.
9. Hermes must remain intact beside Lumen throughout this rollout.
10. The narrow proving behaviors that already work (`github-story`, `discord-reply`) MUST keep working until explicitly amended by a later proposal.

## Rollback Anchor

The rollback anchor is the current proving deployment:

- Lumen remains a narrow GitHub/Discord proving runtime
- no context-authority workflow template exists
- no canonical authority artifact set exists
- no dedicated Lumen GitHub identity is configured
- no signed repo-write posture is enabled

Rollback returns to that model by disabling any new authority workflows, leaving new artifact files on disk for inspection, and continuing to use the current proving contract only.

## Success Criteria For "Observed" -> "Amended Or Retired"

- Lumen refreshes the declared repo index and at least one per-repo context pack on the live loop without operator babysitting.
- The authority snapshot can answer "what changed" and "what is true right now" from current managed artifacts.
- Docs drift findings produce a managed update queue instead of only prose summaries.
- The operator can trace every authority answer back to a current artifact and source refs.
- Identity bootstrap is documented, approved, and exercised in a supervised dry run before any signed repo writes are enabled.

## Task Class

`lumen-context-authority`

## Variant Strategy

Single

The first observed slice is the Stage 1 observe-and-normalize path only. Multi-variant artifact generation is not warranted yet.

## Routing Policy At Launch

Production for documentation and planning artifacts.

Proving-only for any new runtime behavior until the first authority loop is observed on the live host.

## Budget Ceiling

- Max ticks: unchanged dispatch cadence on the existing Lumen timer
- Max variants: 1 authority pass per eligible workflow state
- Max spend per tick: one repo-review bundle plus managed artifact writes for the selected scope
- Initial repo set: operator-declared subset first, not all repos at once

## Target State

After this proposal lands and is observed:

- Lumen continuously reviews AIBTC repos and docs on the live short loop
- Lumen maintains a canonical managed artifact set about current AIBTC code and docs state
- operator and peer-agent answers prefer the authority snapshot and repo context packs over model recall
- docs/wiki refresh work is generated from drift evidence
- Lumen has a documented path to its own email, GitHub identity, `gh` auth, and signed git posture

## Schema Changes

No runtime DB schema change is required for the first implementation slice.

File-backed contracts added:

- `proposals/0006-lumen-context-authority.md`
- `deploy/lumen/CONTEXT_AUTHORITY.md`
- `backlog/lumen-context-authority.json`

Artifact path conventions to add in implementation:

- `context/aibtc/repo-index/latest.json`
- `context/aibtc/repos/<repo-slug>/latest.json`
- `context/aibtc/change-digests/<yyyy-mm-dd>/<tick-id>.md`
- `context/aibtc/docs-drift/<yyyy-mm-dd>/<tick-id>.json`
- `context/aibtc/wiki-refresh/<repo-slug>/<tick-id>.md`
- `context/aibtc/authority-snapshot/latest.json`
- `context/aibtc/open-update-queue/latest.json`

## Runtime Changes

Initial implementation work, in dependency order:

1. Add a context-authority runbook and seed backlog without changing live behavior.
2. Add an authority-oriented Lumen workflow template for recurring repo review.
3. Extend task payload and prompt assembly so authority tasks can declare:
   - repo targets
   - local mirror paths or checkout roots
   - doc roots
   - freshness windows
   - output artifact paths
4. Extend bundle compilation to capture declared repo-review targets and freshness inputs in the bundle document.
5. Extend artifact writing to support structured authority artifacts with explicit metadata and provenance.
6. Add dashboard/report visibility for artifact freshness, stale authority snapshot status, and update queue size.

Out of scope for the first implementation slice:

- autonomous GitHub writes
- autonomous wiki pushes
- autonomous Discord or cross-agent posting from the new authority lane
- unattended use of signing keys for repo mutations

## Migration / Backfill

- No DB migration.
- No historical backfill is required for the initial slice.
- Existing proving artifacts remain historical evidence only.
- The first live authority run SHOULD create fresh artifacts rather than attempting to rewrite old proving summaries into the new taxonomy.

## Tests

Required cases for the first runtime implementation slice:

1. Unit: authority workflow template creates the expected review task with declared repo/doc targets.
2. Unit: authority task prompt includes repo targets, doc roots, freshness window, and output artifact contract.
3. Unit: authority artifacts are written only under the managed artifact root and include provenance metadata.
4. Unit: bundle compilation records declared repo-review targets and freshness inputs.
5. Integration: one review loop tick writes `repo-index` and one per-repo context pack.
6. Integration: stale or missing context artifacts produce an `open-update-queue` artifact.
7. Integration: authority-answer tasks prefer the current authority snapshot and fail closed when required artifacts are missing or stale.

Execution command remains `bun test`.

## Observability

The authority tranche SHOULD add or expose:

- artifact freshness timestamps in the operator dashboard
- counts for stale repo context packs and pending update-queue items
- run events for authority refresh milestones such as `repo_context_refreshed`, `docs_drift_detected`, and `authority_snapshot_refreshed`
- snapshot/report inclusion of the latest authority snapshot path and age

## Acceptance Gate

This proposal is accepted for implementation when:

- the staged roadmap, operator checkpoints, and identity bootstrap plan are reviewed in-repo
- the first implementation slice is explicitly limited to Stage 1 observe-and-normalize work
- no live write scope is widened without a follow-on reviewed amendment

This proposal is accepted as observed when:

- Lumen produces fresh repo context artifacts on the live loop
- the authority snapshot is current and traceable to source refs
- the open update queue is populated from observed drift, not operator memory

## Rollback

- disable new authority workflows
- stop generating the new context-authority artifacts
- leave generated artifacts on disk for inspection
- continue running the current proving GitHub/Discord contract only
- defer identity bootstrap execution until a later reviewed attempt

## Known Future Work

Explicitly deferred:

- Proposal `0004` resilience classification
- Proposal `0005` judge ignition
- Proposal `0005.5` constitution hashing
- autonomous signed repo writes
- docs/wiki publication handlers
- cross-agent authority response routing over an outbox

Proposal numbering note:

- `0004` and `0005` are already reserved by `0002` for earlier deferred substrate follow-ons, so this proposal uses `0006`.

## One-Line Gates

- Delete gate - artifact-less AIBTC knowledge and ad hoc authority claims are deleted
- Merge gate - roadmap, artifact taxonomy, workflow plan, and identity bootstrap runbook are reviewed
- Runtime gate - Stage 1 repo-review artifacts land without widening external write scope
- Observation gate - live Lumen loop refreshes authority artifacts from current evidence
- Promotion gate - docs/wiki sync and authority answers may build on the observed artifact lane
