# Agent Runtime Schema Draft

This draft captures the smallest reusable runtime contract that separates:

- runtime engine
- agent identity
- adapter wiring
- skills
- sensors
- task/workflow state
- execution evidence

It is designed from two sources:

- the current `agent-runtime` proof in this repo
- the older `arc-starter` family running on Arc, Loom, and Forge
- follow-up runtime decisions from live operator experience

## Why This Exists

The older runtime works in production, but the engine, identity, skills, services, and domain tables are bundled together inside each agent repo. That made Arc, Loom, and Forge effective, but it also made them diverge as purpose-specific behavior accumulated.

The newer `agent-runtime` proof is moving in the right direction, but some declared fields are still metadata instead of enforced contracts.

The schema below keeps the durable parts of the old system while unbundling agent-specific state from the shared runtime.

## Design Rules

1. A task is grounded input plus bounded context requirements.
2. Every execution attempt produces evidence.
3. Success is based on runtime evidence, not narration alone.
4. Agent identity is configuration, not engine code.
5. Skills are runtime capabilities, not just prompt labels.
6. Sensors enqueue tasks; they do not keep agents awake in blind loops.
7. Priority controls queue order, not model choice.
8. Model choice should be explicit whenever possible.
9. Scheduling should stay simple and relative, such as "run in X minutes".

## Package Layout

If this moves into `tx-schemas`, the package should expose stable schemas for:

- `agent.identity`
- `agent.profile`
- `adapter.config`
- `skill.manifest`
- `sensor.event`
- `task.intent`
- `task.record`
- `task.attempt`
- `task.outcome`
- `workflow.definition`
- `workflow.record`
- `artifact.record`
- `wallet.identity`

## 1. Agent Identity

This must be separate from the runtime engine.

An AGENT is the durable top-level entity (one per VM). It carries three identity faces simultaneously:

- **Internal identity** — the given name the operator and peer agents address. Always exists, stable across the agent's lifetime. Examples: `arc`, `arc0btc`, `spark`, `loom`, `forge`, `lumen`.
- **External identity** — the AIBTC-registered agent name, derived from the agent's segwit address and resolvable via AIBTC API. Examples: "Trustless Indra", "Rising Leviathan". Acquired via wallet signature registration; may be absent before registration.
- **On-chain identity** — an ERC-8004-compatible Clarity contract entry carrying validation + reputation state. Queryable by judges and peers.

AGENT identity is durable. Subagents (see §3) are ephemeral `(agent, skill)` pairs whose variant lineage evolves; the AGENT behind them does not.

```ts
type AgentIdentity = {
  agent_id: string;                      // canonical key; matches internal_name
  internal_name: string;                 // arc, loom, forge, lumen, spark
  external_name?: {                      // AIBTC-registered, wallet-derived
    name: string;                        // "Trustless Indra", "Rising Leviathan"
    registered_at?: string;
    source: "aibtc-api" | "local-cache";
    wallet_ref: string;                  // segwit address that authored the registration
  };
  onchain_identity?: {                   // ERC-8004-compatible Clarity contract
    contract: string;                    // SPXXX.identity-registry
    token_id?: string;
    reputation_ref?: string;             // contract/method to read reputation summary
  };
  display_name: string;                  // UI label; often same as internal_name capitalized
  codename?: string;                     // legacy alias retained for compatibility
  purpose_ref?: string;                  // path to PURPOSE.md artifact (see §1b)
  soul_ref?: string;                     // path to SOUL.md artifact (see §1b)
  host?: string;
  user?: string;
  runtime_instance_id?: string;
  metadata?: Record<string, unknown>;
};
```

Invariants:

- The runtime must not hardcode per-agent identity the way `arc-starter/src/identity.ts` does.
- `internal_name` is load-bearing; `external_name` and `onchain_identity` may be absent but must never override the internal name.
- Wallet and on-chain identity are first-class but remain data, not engine code.

## 1b. Agent Constitution

Each AGENT carries a constitution — two documents, written by the agent, versioned as artifacts, hashed into every bundle the agent produces (see runtime planning doc, Proposal 0005.5).

```ts
type AgentConstitution = {
  agent_id: string;
  soul_path: string;                     // SOUL.md — identity, values, communication style
  purpose_path: string;                  // PURPOSE.md — goals, weighted self-eval metrics
  soul_hash: string;                     // content hash at time of bundle compilation
  purpose_hash: string;
  version: string;                       // semver or ISO8601 revision marker
  revised_at: string;
};
```

Invariants:

- SOUL.md and PURPOSE.md are AGENT-level, not per-subagent. A subagent inherits its agent's constitution; it does not carry its own.
- Constitution changes go through the proposal lane (see runtime planning doc) — an agent may draft a revision, but the operator accepts.
- The constitution hash is a bundle input. Two ticks with the same `(bundle_hash, variant_id)` must produce comparable outcomes — which requires the constitution to be pinned, not swapped mid-run.

## 1a. Wallet Identity

This should be first-class and standardized.

```ts
type WalletIdentity = {
  agent_id: string;
  chain: string;                  // stacks, bitcoin, ethereum, etc
  network?: string;               // mainnet, testnet, devnet
  address: string;
  public_key?: string;
  name?: string;                  // BNS or similar name
  capabilities?: string[];        // sign, heartbeat, message, claim, publish
  onchain_identity_contract?: string;  // ERC-8004 Clarity contract principal, if linked
  reputation_ref?: string;             // contract/method for reputation reads
  metadata?: Record<string, unknown>;
};
```

Invariants:

- Wallet identity is attached to the agent through data records, not embedded constants.
- When `onchain_identity_contract` is set, it must match the `onchain_identity.contract` in `AgentIdentity` (§1). The two records are joined by `agent_id`; conflicts are a bug, not a merge.

## 2. Adapter Config

The engine should dispatch through a common adapter contract.

```ts
type AdapterConfig =
  | {
      adapter_id: string;
      kind: "claude-code";
      command: string;
      working_dir?: string;
      timeout_ms: number;
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      env_file?: string;
      env?: Record<string, string>;
      model?: string;
      autonomy?: {
        profile: "restricted" | "trusted-vm";
        required_args?: string[];
        required_settings_files?: string[];
      };
      extra_args?: string[];
    }
  | {
      adapter_id: string;
      kind: "codex";
      command: string;
      working_dir?: string;
      timeout_ms: number;
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      env_file?: string;
      env?: Record<string, string>;
      model?: string;
      provider?: {
        id: string;
        name?: string;
        base_url?: string;
        wire_api?: "responses";
        requires_openai_auth?: boolean;
      };
      autonomy?: {
        profile: "restricted" | "trusted-vm";
        required_args?: string[];
      };
      extra_args?: string[];
    }
  | {
      adapter_id: string;
      kind: "hermes-agent";
      command: string;
      working_dir?: string;
      timeout_ms: number;
      sandbox?: "read-only" | "workspace-write" | "danger-full-access";
      env_file?: string;
      env?: Record<string, string>;
      model?: string;
      autonomy?: {
        profile: "restricted" | "trusted-vm";
        required_args?: string[];
      };
      extra_args?: string[];
    }
  | {
      adapter_id: string;
      kind: "ollama-generate";
      endpoint: string;
      model: string;
      timeout_ms: number;
    }
  | {
      adapter_id: string;
      kind: "script";
      command: string;
      working_dir?: string;
      timeout_ms: number;
      env_file?: string;
      env?: Record<string, string>;
      autonomy?: {
        profile: "runtime-native";
      };
      extra_args?: string[];
    };
```

Invariant:

- Hermes Agent is treated as another harness adapter, not a special autonomous runtime.
- `script` is first-class for deterministic or repetitive work that does not need an LLM call.
- Every adapter kind must emit the same `TaskAttempt` evidence bundle shape.
- Harness adapters that rely on trusted-VM autonomy must declare that posture explicitly instead of burying it in `extra_args`.

## 3. Subagent Profile

A SUBAGENT is the `(agent, skill)` pair a task is delegated to. The subagent profile describes what that pair can do — adapter wiring, skill set, result policies. It never re-declares AGENT identity (§1) or constitution (§1b); those are inherited at bundle-compile time.

Profiles choose behavior without baking identity into the engine. In the planning doc's market framing, a subagent's variant lineage is `(skill_id, skill_version, agent_def_version)` — the profile is the static shape; the variant is what evolves.

```ts
type SubagentProfile = {
  profile_id: string;                       // formerly "agent profile"
  style: "claude-like" | "codex-like" | "hermes-like";
  role: string;                             // operational role, not identity
  default_adapter_id: string;
  default_model?: string;
  prompt_parts: string[];                   // operational framing, not SOUL content
  skill_ids: string[];
  context_policy: {
    max_prompt_chars: number;
    include_recent_memory: boolean;
  };
  result_policy: {
    allow_follow_up_tasks: boolean;
    allow_external_messages: boolean;
  };
  integration_policy?: Record<string, string>;
};
```

Invariants:

- Fields in this schema must either be enforced by the runtime or removed.
- `prompt_parts` is operational framing (how to handle this role's tasks). It does not duplicate SOUL.md — the constitution is loaded separately via the bundle.
- A subagent has no identity of its own. Its identity is `(agent_id, profile_id, variant_id)` composed at dispatch time.

## 4. Skill Manifest

Skills should be operational capabilities with discoverable assets.

```ts
type SkillManifest = {
  skill_id: string;
  description: string;
  tags?: string[];
  instruction_path: string;        // SKILL.md
  subagent_path?: string;          // AGENT.md
  cli_commands?: Array<{
    name: string;
    command: string;
    description?: string;
  }>;
  sensor_path?: string;
  input_schema_id?: string;
  output_schema_id?: string;
};
```

Invariant:

- The runtime resolves `skill_id` to files and CLI surfaces explicitly.
- `skill_id` must not just be a string pasted into prompt text.

## 5. Sensor Event / Intake Envelope

Sensors should push grounded work into the queue.

```ts
type SensorEvent = {
  sensor_id: string;
  event_id: string;
  observed_at: string;
  source_ref: string;
  dedupe_key: string;
  freshness_deadline?: string;
  payload: Record<string, unknown>;
  proposed_task?: TaskIntent;
  proposed_workflow?: {
    template: string;
    instance_key: string;
    state?: string;
    context?: Record<string, unknown>;
  };
};
```

Invariants:

- `dedupe_key` is sensor-owned and stable.
- Sensors enqueue tasks only when freshness and trigger conditions are satisfied.
- Sensors may create or wake workflows, but workflow state owns dependent task progression.

## 6. Task Intent

This is the portable unit sensors, operators, and workflows create.

```ts
type TaskIntent = {
  task_type: string;
  source: string;
  subject?: string;
  description?: string;
  priority?: number;
  requested_profile_id?: string;
  requested_adapter_id?: string;
  requested_model?: string;
  skill_ids?: string[];
  workflow_ref?: {
    workflow_id: string;
    state_id: string;
    instance_key: string;
  };
  schedule?: {
    delay_minutes: number;
  };
  available_at?: string;
  payload: Record<string, unknown>;
  evidence_requirements?: {
    required_artifacts?: string[];
    require_file_change_verification?: boolean;
    require_adapter_audit?: boolean;
  };
};
```

Invariants:

- `requested_model` is explicit when a task needs a specific model.
- `priority` affects queue order only and must not silently choose a model.
- Scheduling stays simple and relative through `delay_minutes`, not calendar complexity.
- Absolute `available_at` is accepted by the runtime for trusted operator/runtime callers; portable sensors should prefer relative delay.

## 7. Task Record

This is engine state, not author input.

```ts
type TaskRecord = {
  task_id: string;
  task_type: string;
  source: string;
  subject: string | null;
  description: string | null;
  priority: number;
  payload: Record<string, unknown>;
  requested_profile_id: string;
  requested_adapter_id: string | null;
  requested_model: string | null;
  status: "pending" | "running" | "completed" | "retryable_failure" | "permanent_failure" | "blocked" | "operator_canceled";
  max_attempts: number;
  attempt_count: number;
  available_at: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  outcome: TaskOutcome | null;
  last_error: string | null;
};
```

This is the main upgrade over the current proof:

- add `requested_model`
- keep execution provenance in `TaskAttempt` rows rather than embedding lease state in the task row under the single-runner contract
- defer lease/heartbeat fields until the concurrent-runner proposal lands

## 8. Task Attempt

Each execution attempt must be evidence-bearing.

```ts
type TaskAttempt = {
  attempt_id: string;
  task_id: string;
  adapter_id: string;
  adapter_kind: string;
  model: string | null;
  runner_id: string;
  started_at: string;
  ended_at: string | null;
  exit_status: "ok" | "error" | "timeout";
  retry_class: "none" | "retryable" | "permanent";
  prompt_path?: string;
  stdout_path?: string;
  stderr_path?: string;
  result_path?: string;
  last_message_path?: string;
  diagnostics?: Record<string, unknown>;
};
```

Invariant:

- Ollama, Codex, Claude Code, and Hermes Agent all produce this shape.

## 9. Task Outcome

This is the canonical post-normalization result.

```ts
type TaskOutcome = {
  status: "completed" | "retryable_failure" | "permanent_failure" | "blocked" | "operator_canceled";
  machine_status: "ok" | "needs_retry" | "blocked" | "failed" | "canceled";
  operator_summary: string;
  raw_output?: string;
  file_changes?: string[];
  artifact_paths?: string[];
  workflow_signal?: string;
  follow_up_tasks?: TaskIntent[];
  external_messages?: Array<Record<string, unknown>>;
};
```

Invariants:

- `completed` requires `machine_status === "ok"`.
- `operator_canceled` is emitted by runtime operator controls, not by agent model output.
- `artifact_paths` must resolve on disk if artifacts were declared.
- Until the resilience/outbox proposal lands, `follow_up_tasks` and `external_messages` may be recorded but MUST NOT be treated as delivered side effects.
- Once runtime handlers exist, `follow_up_tasks` and `external_messages` must be applied only after verification and through those handlers.

## 10. Workflow Definition

Workflow logic should be data-backed, even if execution code stays simple.

```ts
type WorkflowDefinition = {
  workflow_type: string;
  initial_state: string;
  states: Array<{
    state_id: string;
    task_type?: string;
    default_profile_id?: string;
    default_skill_ids?: string[];
    transitions?: Array<{
      signal: string;
      next_state: string;
    }>;
    completion_signals?: string[];
    emits_task_intent?: boolean;
  }>;
};
```

For now, `goal-loop` is the important portable one:

- `plan`
- `execute`
- `verify`
- `complete`

## 11. Workflow Record

```ts
type WorkflowRecord = {
  workflow_id: string;
  workflow_type: string;
  instance_key: string;
  current_state: string;
  context: Record<string, unknown> | null;
  status: "active" | "completed" | "blocked";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};
```

Invariants:

- Workflows are first-class because they are useful for multi-step processes where one verified task intentionally creates the next.
- Workflow progression is driven by recorded signals and runtime-applied follow-up creation, not by narration alone.

## 11b. Recurring Schedule Record

Recurring schedules are runtime-owned rows that enqueue normal task intents. They decide when work should exist; they do not execute work directly.

```ts
type RecurringScheduleRecord = {
  schedule_id: string;
  name: string;
  enabled: boolean;
  interval_seconds: number;
  next_run_at: string;
  last_run_at: string | null;
  task: TaskIntent;
  created_at: string;
  updated_at: string;
};
```

Invariants:

- Dispatch evaluates due schedules before workflow evaluation and task claiming.
- Each due run is enqueued as a normal task with an `available_at` gate and a schedule-derived source key.
- Recurring schedules are for consistency, not dependency management; dependent progression remains workflow-owned.
- Catch-up is coalesced: one schedule evaluation creates at most one task per due schedule, then advances from the evaluation time by one interval. Missed schedule slots are recorded as one due task instead of replayed one interval at a time.

## 12. Artifact Record

Artifacts should be tracked, not inferred ad hoc from task type.

```ts
type ArtifactRecord = {
  artifact_id: string;
  task_id: string;
  role: "plan" | "execute-report" | "verify-report" | "output" | "snapshot" | "adapter-audit";
  relative_path: string;
  content_type?: string;
  created_at: string;
  verified_at?: string;
};
```

## 13. Task Type Registry

The runtime needs a registry that replaces scattered task-kind branching.

```ts
type TaskTypeSpec = {
  task_type: string;
  payload_schema_id: string;
  default_profile_id?: string;
  default_adapter_id?: string;
  default_model?: string;
  allowed_skill_ids?: string[];
  artifact_roles?: string[];
  success_policy?: {
    require_artifacts?: boolean;
    require_adapter_audit?: boolean;
    verify_claimed_file_changes?: boolean;
  };
};
```

This is the contract that should replace:

- hardcoded artifact routing
- hardcoded pollution detection by task kind
- hardcoded context rules by phase

## 14. Minimum Runtime Events

```ts
type RuntimeEvent =
  | "task_enqueued"
  | "task_claimed"
  | "bundle_compiled"
  | "task_retry_scheduled"
  | "task_attempt_finished"
  | "task_started"
  | "task_finished"
  | "schedule_upserted"
  | "schedule_task_created"
  | "sensor_event_recorded"
  | "sensor_event_deduped"
  | "sensor_task_created"
  | "sensor_workflow_created"
  | "sensor_workflow_deduped"
  | "workflow_transitioned"
  | "workflow_completed"
  | "workflow_task_created"
  | "dispatch_idle"
  | "dispatch_locked"
  | "boot_sweep_reclaimed"
  | "dispatch_lock_stale_cleared";
```

## Old Runtime Mapping

The old runtime already proved these durable ideas:

- one task queue per agent VM
- explicit `tasks` table
- `skills` attached to tasks
- sensors as separate runners
- workflows for multi-step handoff
- simple relative future scheduling
- explicit queue priority
- dispatch lock
- cycle logging and cost accounting
- schema migrations recorded in `schema_migrations`
- read-only operator surfaces

The parts that should not survive as engine contracts:

- repo/package naming tied to one agent (`arc-agent`, `arc` CLI)
- service names tied to one agent (`arc-dispatch`, `arc-sensors`)
- identity and wallet tables/constants embedded in runtime code
- domain tables bundled into the same runtime package
- fleet- or product-specific behavior living in generic dispatch code

## Recommendation For `tx-schemas`

If this moves to `aibtcdev/tx-schemas`, publish:

- JSON Schema for the runtime records above
- TypeScript types generated from the same source
- versioned schema IDs like `agent-runtime/task.record/v1`

Start with:

1. `task.intent`
2. `task.record`
3. `task.attempt`
4. `task.outcome`
5. `workflow.record`
6. `adapter.config`
7. `skill.manifest`
8. `wallet.identity`

That is the smallest stable surface that can support:

- Arc and Loom on Claude Code
- Forge on Codex
- Lumen on Hermes Agent, Codex, or Ollama-backed proving flows
- future agents cloned onto fresh VMs without rebundling engine and identity
