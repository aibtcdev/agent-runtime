# Clone Contract

This file defines the minimum package for spinning up a sibling agent VM beside Lumen.

The objective is not just another proving host. The objective is a cloneable agent package that keeps `agent-runtime` shared while the agent-specific identity and purpose stay explicit.

## What Must Stay Shared

These should move in lock-step across `arc`, `lumen`, `forge`, and later agents:

- runtime engine code under `src/`
- task/attempt/bundle schema
- adapter contracts
- healthcheck behavior
- audit artifact layout
- systemd unit templates
- operator dashboard surfaces

## What Must Be Agent-Specific

Each cloned agent gets its own package:

- `IDENTITY.md`
- `PURPOSE.md`
- profile selection and default adapter
- runtime instance config
- host-local override config
- seeded backlog
- state root
- systemd instance name

## Constitution Note

The runtime schema currently talks about `SOUL.md` plus `PURPOSE.md` as the long-term constitution pair.

For the next VM bring-up, treat `IDENTITY.md` as the operator-facing source document for identity, tone, and non-goal constraints. When constitution hashing lands, `IDENTITY.md` can either become `SOUL.md` or generate it.

That keeps current planning aligned with the schema without blocking the next clone.

## Minimum Package Shape

Recommended layout for a new agent named `<agent>`:

```text
agent-runtime/
  deploy/<agent>/
    IDENTITY.md
    PURPOSE.md
    runtime.<agent>.json
    runtime.<agent>.host.example.json
    DEPLOY.md
  backlog/
    <agent>.seed.json
  templates/agent-package/
    IDENTITY.md
    PURPOSE.md
```

Host-local, not checked in:

```text
~/.config/agent-runtime/<agent>.host.json
```

## Identity Inputs Required Before The First Clone

We do not need the full big-picture design to start, but we do need these pinned before the new VM is promoted:

- agent name
- short mission sentence
- primary task domain
- default adapter on day one
- whether the agent is read-only, artifact-writing, or repo-writing
- where its state root lives on disk

## Quiet-Loop Contract

When sensors are quiet, the agent should not invent work from thin air. Its fallback loop should read from:

- `IDENTITY.md`
- `PURPOSE.md`
- current evidence
- queued work

Allowed quiet-loop work:

- refresh context artifacts
- inspect declared repos or docs
- detect drift
- update task backlog
- produce operator summaries
- run bounded self-maintenance

Disallowed quiet-loop work unless explicitly approved for that agent:

- external posting
- arbitrary repo mutation
- credential changes
- identity/bootstrap actions

## First Sibling VM Gate

The first sibling agent beside Lumen is ready to call real when all of these are true:

- the VM boots from the shared runtime repo without ad hoc runtime edits
- the agent package exists with `IDENTITY.md` and `PURPOSE.md`
- host-local override config passes `healthcheck`
- one canonical comparison task completes through the intended adapter
- one purpose-specific task completes cleanly
- the deploy notes are specific enough that the VM could be recreated by an operator later

## Naming Input

The next blocked external input is the sibling agent name.

Everything else in this file can be prepared before that name is final.
