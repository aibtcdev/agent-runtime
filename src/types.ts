export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "retryable_failure"
  | "permanent_failure"
  | "blocked"
  | "operator_canceled";

export type AttemptStatus = "running" | "finished";
export type AttemptExitStatus = "ok" | "error" | "timeout";
export type AttemptRetryClass = "none" | "retryable" | "permanent";
export type ReplayGrade = "inputs_frozen" | "best_effort" | "non_replayable_model";

export type RuntimeConfig = {
  runtimeName: string;
  runtimePolicy: string;
  stateDir: string;
  logDir: string;
  artifactDir: string;
  dbPath: string;
  lockPath: string;
  defaultProfile: string;
  defaultAdapter: string;
  maxAttempts: number;
  retryBackoffSeconds: number;
  profiles: Record<string, string>;
  adapters: Record<string, AdapterConfig>;
};

export type OllamaGenerateAdapterConfig = {
  mode: "ollama-generate";
  endpoint: string;
  model: string;
  timeoutMs: number;
};

export type AgentCliAdapterConfig = {
  mode: "agent-cli";
  driver: "codex" | "claude-code" | "hermes-agent";
  command: string;
  timeoutMs: number;
  model?: string;
  workingDir?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  envFile?: string;
  settingsFile?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  providerId?: string;
  providerName?: string;
  providerBaseUrl?: string;
  providerWireApi?: "responses";
  providerRequiresOpenAIAuth?: boolean;
  autonomy?: "restricted" | "trusted-vm";
};

export type ScriptAdapterConfig = {
  mode: "script";
  command: string;
  timeoutMs: number;
  workingDir?: string;
  envFile?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
};

export type AdapterConfig = OllamaGenerateAdapterConfig | AgentCliAdapterConfig | ScriptAdapterConfig;

export type Profile = {
  profile_id: string;
  style: "claude-like" | "codex-like" | "hermes-like";
  role: string;
  system_prompt_parts: string[];
  skills: string[];
  default_adapter: string;
  tool_policy: Record<string, boolean>;
  context_policy: {
    include_recent_task_memory: boolean;
    max_prompt_chars: number;
  };
  result_schema: Record<string, boolean | string>;
  integration_policies: Record<string, string>;
};

export type TaskInput = {
  kind: string;
  source: string;
  subject?: string;
  description?: string;
  priority?: number;
  payload: Record<string, unknown>;
  requested_profile?: string;
  requested_adapter?: string;
  max_attempts?: number;
  available_at?: string;
  schedule?: {
    delay_minutes?: number;
  };
};

export type TaskRecord = {
  task_id: string;
  kind: string;
  source: string;
  subject: string | null;
  description: string | null;
  priority: number;
  payload: Record<string, unknown>;
  requested_profile: string;
  requested_adapter: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  outcome: CanonicalOutcome | null;
  last_error: string | null;
};

export type TaskAttemptRecord = {
  attempt_id: string;
  task_id: string;
  adapter_id: string;
  adapter_kind: string;
  model: string | null;
  runner_id: string;
  bundle_id: string | null;
  status: AttemptStatus;
  started_at: string;
  ended_at: string | null;
  exit_status: AttemptExitStatus | null;
  retry_class: AttemptRetryClass | null;
  prompt_path: string | null;
  stdout_path: string | null;
  stderr_path: string | null;
  result_path: string | null;
  diagnostics: Record<string, unknown> | null;
};

export type BundleArtifactRecord = {
  bundle_id: string;
  task_id: string;
  attempt_id: string;
  bundle_hash: string;
  agent_id: string | null;
  profile_id: string;
  adapter_id: string;
  model: string | null;
  variant_id: string | null;
  evaluator_version: string | null;
  replay_grade: ReplayGrade;
  relative_path: string;
  prompt_relative_path: string;
  created_at: string;
};

export type ClaimedTaskRecord = {
  task: TaskRecord;
  attempt: TaskAttemptRecord;
};

export type ExecutionRequest = {
  task: TaskRecord;
  attempt: TaskAttemptRecord;
  bundle: BundleArtifactRecord;
  profile: Profile;
  adapterId: string;
  adapterConfig: AdapterConfig;
  runtimeConfig: RuntimeConfig;
  assembledContext: string;
};

export type AdapterExecutionResult = {
  rawOutput: string;
  parsedOutput?: unknown;
  usage?: Record<string, unknown>;
  exitStatus: "ok" | "error" | "timeout";
  retryClass: "none" | "retryable" | "permanent";
  diagnostics?: Record<string, unknown>;
};

export type CanonicalOutcome = {
  status: Exclude<TaskStatus, "pending" | "running">;
  operator_summary: string;
  machine_status: "ok" | "needs_retry" | "blocked" | "failed" | "canceled";
  attempt_id?: string;
  bundle_id?: string;
  bundle_hash?: string;
  file_changes?: string[];
  artifact_paths?: string[];
  follow_up_tasks?: TaskInput[];
  external_messages?: Array<Record<string, unknown>>;
  workflow_signal?: string;
  raw_output?: string;
};

export type Workflow = {
  id: number;
  template: string;
  instance_key: string;
  current_state: string;
  context_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type RecurringScheduleInput = {
  schedule_id?: string;
  name: string;
  interval_seconds: number;
  task: TaskInput;
  next_run_at?: string;
  enabled?: boolean;
};

export type RecurringScheduleRecord = {
  schedule_id: string;
  name: string;
  enabled: boolean;
  interval_seconds: number;
  next_run_at: string;
  last_run_at: string | null;
  task: TaskInput;
  created_at: string;
  updated_at: string;
};

export type SensorEventInput = {
  sensor_id: string;
  event_id: string;
  observed_at?: string;
  source_ref: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  proposed_task?: TaskInput;
  proposed_workflow?: {
    template: string;
    instance_key: string;
    state?: string;
    context?: Record<string, unknown>;
  };
};

export type SensorEventRecord = {
  sensor_event_id: string;
  sensor_id: string;
  event_id: string;
  observed_at: string;
  source_ref: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  task_id: string | null;
  workflow_id: number | null;
  created_at: string;
};

export type WorkflowAction = {
  type: "create-task" | "transition" | "noop";
  task?: TaskInput;
  nextState?: string;
  contextPatch?: Record<string, unknown>;
};

export type SnapshotTaskCount = {
  status: string;
  count: number;
};

export type SnapshotRecentCompletedTask = {
  task_id: string;
  kind: string;
  source: string;
  subject: string | null;
  updated_at: string;
  operator_summary: string;
  artifact_paths: string[];
};

export type SnapshotWorkflow = {
  id: number;
  template: string;
  instance_key: string;
  current_state: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  context: Record<string, unknown> | null;
};

export type RuntimeSnapshot = {
  captured_at: string;
  runtime_name: string;
  status: {
    counts: SnapshotTaskCount[];
    recent: Array<Record<string, unknown>>;
    lastEvent: Record<string, unknown> | null;
  };
  workflows: SnapshotWorkflow[];
  active_workflows: SnapshotWorkflow[];
  queued_tasks: Array<Record<string, unknown>>;
  recent_completed: SnapshotRecentCompletedTask[];
  artifact_files: string[];
};

export type RunEventRecord = {
  id: number;
  event_type: string;
  task_id: string | null;
  attempt_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};
