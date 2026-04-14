import type { TaskRecord, Workflow, WorkflowAction, TaskInput } from "./types";

type StateConfig<C = Record<string, unknown>> = {
  on?: Record<string, string>;
  action?: (context: C) => WorkflowAction | null;
  autoTransitionOnCompletedKinds?: Record<string, string>;
  completeOnCompletedKinds?: string[];
};

type StateMachine<C = Record<string, unknown>> = {
  name: string;
  initialState: string;
  states: Record<string, StateConfig<C>>;
};

type CommunityResearchContext = {
  slug?: string;
  topic?: string;
  output_path?: string;
  outline_path?: string;
  current_focus?: string;
};

type WalletOnboardingContext = {
  slug?: string;
  agent_name?: string;
  checklist_path?: string;
};

type GoalLoopContext = {
  summary?: string;
  objective?: string;
  scope?: string[];
  requested_profile?: string;
  base_name?: string;
  plan_phase_skills?: string[];
  verify_plan_phase_skills?: string[];
  execute_phase_skills?: string[];
  verify_execute_phase_skills?: string[];
  execution_iteration?: number;
  plan_artifact?: string;
};

const CommunityResearchMachine: StateMachine<CommunityResearchContext> = {
  name: "community-research",
  initialState: "discover-aibtc-basics",
  states: {
    "discover-aibtc-basics": {
      on: { basics_researched: "draft-community-wiki-outline" },
      autoTransitionOnCompletedKinds: {
        "community-research": "basics_researched"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "community-research",
          source: "workflow:pending",
          subject: `Research AIBTC basics for ${ctx.topic || "community wiki"}`,
          description:
            "Use the provided docs to extract the key platform, messaging, registration, and news concepts that a new community member needs to understand.",
          priority: 6,
          requested_profile: "lumen",
          payload: {
            topic: ctx.topic ?? "AIBTC community onboarding",
            focus: ctx.current_focus ?? "platform-basics",
            output_path: ctx.output_path ?? "community-wiki/aibtc-basics.md",
            sources: ["docs/aibtc-platform.md", "docs/aibtc-news.md"],
            operator_goal: "Produce a concise research summary Lumen can reuse for community explanations."
          }
        }
      })
    },
    "draft-community-wiki-outline": {
      on: { outline_complete: "research-wallet-onboarding" },
      autoTransitionOnCompletedKinds: {
        "community-wiki-outline": "outline_complete"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "community-wiki-outline",
          source: "workflow:pending",
          subject: "Draft the first community wiki outline",
          description: "Turn the AIBTC research into a community-wiki outline with sections, priorities, and gaps.",
          priority: 5,
          requested_profile: "lumen",
          payload: {
            topic: ctx.topic ?? "AIBTC community wiki",
            focus: "wiki-outline",
            output_path: getCommunityOutlinePath(ctx),
            operator_goal: "Produce a useful outline that can later be turned into wiki pages."
          }
        }
      })
    },
    "research-wallet-onboarding": {
      on: { wallet_research_complete: "draft-wallet-setup-guide" },
      autoTransitionOnCompletedKinds: {
        "wallet-onboarding-research": "wallet_research_complete"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "wallet-onboarding-research",
          source: "workflow:pending",
          subject: "Research AIBTC wallet onboarding for Lumen",
          description:
            "Summarize the wallet creation, unlock, registration, heartbeat, and identity steps Lumen will need for AIBTC participation.",
          priority: 6,
          requested_profile: "lumen",
          payload: {
            topic: "Lumen wallet onboarding",
            focus: "wallet-onboarding",
            output_path: "community-wiki/lumen-wallet-onboarding.md",
            sources: ["docs/aibtc-platform.md"],
            operator_goal: "Produce a wallet setup research note with open questions clearly identified."
          }
        }
      })
    },
    "draft-wallet-setup-guide": {
      on: { guide_ready: "review-and-publish-wiki" },
      autoTransitionOnCompletedKinds: {
        "wallet-setup-guide": "guide_ready"
      },
      action: () => ({
        type: "create-task",
        task: {
          kind: "wallet-setup-guide",
          source: "workflow:pending",
          subject: "Draft Lumen wallet setup guide",
          description: "Draft a practical guide for creating and registering a Lumen AIBTC wallet.",
          priority: 5,
          requested_profile: "lumen",
          payload: {
            topic: "Lumen wallet setup guide",
            focus: "wallet-guide",
            output_path: "community-wiki/lumen-wallet-setup-guide.md",
            operator_goal: "Write a usable draft that can later become community-wiki material."
          }
        }
      })
    },
    "review-and-publish-wiki": {
      on: {},
      completeOnCompletedKinds: ["community-wiki-review"],
      action: () => ({
        type: "create-task",
        task: {
          kind: "community-wiki-review",
          source: "workflow:pending",
          subject: "Review community wiki drafts and open publishing gaps",
          description: "Summarize what is ready, what still needs evidence, and what can be published next.",
          priority: 4,
          requested_profile: "lumen",
          payload: {
            topic: "Community wiki review",
            focus: "review",
            output_path: "community-wiki/review.md",
            operator_goal: "Prepare the wiki work for human review and later publishing."
          }
        }
      })
    }
  }
};

const WalletOnboardingMachine: StateMachine<WalletOnboardingContext> = {
  name: "wallet-onboarding",
  initialState: "research-registration-flow",
  states: {
    "research-registration-flow": {
      on: { registration_researched: "draft-wallet-checklist" },
      autoTransitionOnCompletedKinds: {
        "wallet-registration-research": "registration_researched"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "wallet-registration-research",
          source: "workflow:pending",
          subject: `Research AIBTC registration flow for ${ctx.agent_name || "agent"}`,
          description: "Document the wallet, registration, heartbeat, and inbox prerequisites for AIBTC participation.",
          priority: 6,
          requested_profile: "lumen",
          payload: {
            agent_name: ctx.agent_name ?? "Lumen",
            checklist_path: ctx.checklist_path ?? "community-wiki/lumen-wallet-checklist.md",
            sources: ["docs/aibtc-platform.md"],
            operator_goal: "Produce a grounded checklist, not speculative guidance."
          }
        }
      })
    },
    "draft-wallet-checklist": {
      on: {},
      completeOnCompletedKinds: ["wallet-checklist-draft"],
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "wallet-checklist-draft",
          source: "workflow:pending",
          subject: `Draft AIBTC wallet checklist for ${ctx.agent_name || "agent"}`,
          description: "Convert the registration research into a short operational checklist with unresolved blockers called out.",
          priority: 5,
          requested_profile: "lumen",
          payload: {
            agent_name: ctx.agent_name ?? "Lumen",
            checklist_path: ctx.checklist_path ?? "community-wiki/lumen-wallet-checklist.md",
            operator_goal: "Prepare a checklist that can be used during wallet setup."
          }
        }
      })
    }
  }
};

const GoalLoopMachine: StateMachine<GoalLoopContext> = {
  name: "goal-loop",
  initialState: "plan",
  states: {
    plan: {
      on: { plan_ready: "execute" },
      autoTransitionOnCompletedKinds: {
        "goal-plan": "plan_ready"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "goal-plan",
          source: "workflow:pending",
          subject: `Plan goal: ${ctx.summary ?? "workflow goal"}`,
          description: "Create a concrete plan with acceptance criteria, stop conditions, and bounded execution scope.",
          priority: 7,
          requested_profile: ctx.requested_profile ?? "proving-codex",
          payload: {
            objective: ctx.objective ?? ctx.summary ?? "workflow goal",
            summary: ctx.summary ?? "workflow goal",
            scope: ctx.scope ?? [],
            phase: "plan",
            phase_skills: ctx.plan_phase_skills ?? ["planning", "artifact-reporting"],
            proposal_artifact: getGoalLoopPlanArtifact(ctx),
            required_artifacts: [getGoalLoopPlanArtifact(ctx)],
            acceptance_criteria: [
              "Plan includes clear scope",
              "Plan includes acceptance criteria",
              "Plan includes stop condition",
              "Plan is suitable for iterative execution and verification"
            ],
            operator_goal: "Produce the plan artifact for the workflow goal.",
            response_contract: {
              required_workflow_signal: "plan_ready"
            }
          }
        }
      })
    },
    execute: {
      on: { execute_ready: "verify" },
      autoTransitionOnCompletedKinds: {
        "goal-execute": "execute_ready"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "goal-execute",
          source: "workflow:pending",
          subject: `Execute goal iteration ${getExecutionIteration(ctx)}: ${ctx.summary ?? "workflow goal"}`,
          description: "Execute the next bounded chunk of the approved plan and record concrete outputs and remaining work.",
          priority: 7,
          requested_profile: ctx.requested_profile ?? "proving-codex",
          payload: {
            objective: ctx.objective ?? ctx.summary ?? "workflow goal",
            summary: ctx.summary ?? "workflow goal",
            scope: ctx.scope ?? [],
            phase: "execute",
            iteration: getExecutionIteration(ctx),
            phase_skills: ctx.execute_phase_skills ?? ["repo-edit", "verification", "artifact-reporting"],
            proposal_artifact: getGoalLoopPlanArtifact(ctx),
            implementation_artifact: getGoalLoopExecuteArtifact(ctx),
            required_artifacts: [getGoalLoopExecuteArtifact(ctx)],
            operator_goal: "Execute one bounded iteration against the approved plan.",
            response_contract: {
              required_workflow_signal: "execute_ready"
            }
          }
        }
      })
    },
    verify: {
      on: { continue: "execute", complete: "complete", revise_plan: "plan" },
      autoTransitionOnCompletedKinds: {
        "goal-verify": "__signal__"
      },
      action: (ctx) => ({
        type: "create-task",
        task: {
          kind: "goal-verify",
          source: "workflow:pending",
          subject: `Verify execution iteration ${getExecutionIteration(ctx)}: ${ctx.summary ?? "workflow goal"}`,
          description: "Compare the latest execution output against the plan and decide whether to continue executing, revise the plan, or complete the workflow.",
          priority: 7,
          requested_profile: ctx.requested_profile ?? "proving-codex",
          payload: {
            objective: ctx.objective ?? ctx.summary ?? "workflow goal",
            summary: ctx.summary ?? "workflow goal",
            scope: ctx.scope ?? [],
            phase: "verify",
            iteration: getExecutionIteration(ctx),
            phase_skills: ctx.verify_execute_phase_skills ?? ["review", "verification", "artifact-reporting"],
            proposal_artifact: getGoalLoopPlanArtifact(ctx),
            implementation_artifact: getGoalLoopExecuteArtifact(ctx),
            verification_artifact: getGoalLoopVerifyArtifact(ctx),
            required_artifacts: [getGoalLoopVerifyArtifact(ctx)],
            accepted_signals: ["continue", "complete", "revise_plan"],
            operator_goal: "Verify execution against the plan and decide the next loop transition.",
            response_contract: {
              required_workflow_signal: "continue|complete|revise_plan"
            }
          }
        }
      })
    },
    complete: {
      on: {}
    }
  }
};

const templates: Record<string, StateMachine> = {
  "community-research": CommunityResearchMachine,
  "wallet-onboarding": WalletOnboardingMachine,
  "goal-loop": GoalLoopMachine
};

function toArtifactSlug(value?: string): string {
  return (value ?? "community-wiki")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "community-wiki";
}

function getCommunityOutlinePath(ctx: CommunityResearchContext): string {
  if (ctx.outline_path) {
    return ctx.outline_path;
  }
  if (ctx.slug) {
    return `community-wiki/${toArtifactSlug(ctx.slug)}-outline.md`;
  }
  return "community-wiki/outline.md";
}

export function getTemplateByName(name: string): StateMachine | null {
  return templates[name] ?? null;
}

export function evaluateWorkflow(workflow: Workflow, template: StateMachine): WorkflowAction {
  const stateConfig = template.states[workflow.current_state];
  if (!stateConfig?.action) {
    return { type: "noop" };
  }
  const context = workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : {};
  const action = stateConfig.action(context);
  return action ?? { type: "noop" };
}

export function getAllowedTransitions(currentState: string, template: StateMachine): Record<string, string> {
  return template.states[currentState]?.on ?? {};
}

export function getAutoTransitionKinds(currentState: string, template: StateMachine): string[] {
  return Object.keys(template.states[currentState]?.autoTransitionOnCompletedKinds ?? {});
}

export function getCompletionKinds(currentState: string, template: StateMachine): string[] {
  return template.states[currentState]?.completeOnCompletedKinds ?? [];
}

export function resolveCompletedTaskTransition(
  workflow: Workflow,
  template: StateMachine,
  task: TaskRecord | null
): WorkflowAction {
  if (!task) {
    return { type: "noop" };
  }

  const stateConfig = template.states[workflow.current_state];
  if (!stateConfig) {
    return { type: "noop" };
  }

  const eventName = stateConfig.autoTransitionOnCompletedKinds?.[task.kind];
  if (!eventName) {
    return { type: "noop" };
  }

  const resolvedEventName = eventName === "__signal__"
    ? resolveRecordedWorkflowSignal(task)
    : eventName;
  const nextState = stateConfig.on?.[resolvedEventName];
  if (!nextState) {
    return { type: "noop" };
  }

  const existingContext = workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : {};
  const nextIteration = nextState === "verify"
    ? getExecutionIteration(existingContext as GoalLoopContext)
    : resolvedEventName === "continue"
      ? getExecutionIteration(existingContext as GoalLoopContext) + 1
      : getExecutionIteration(existingContext as GoalLoopContext);
  const proposalArtifact = typeof task.payload.proposal_artifact === "string" ? task.payload.proposal_artifact : null;

  return {
    type: "transition",
    nextState,
    contextPatch: {
      last_completed_task_id: task.task_id,
      last_completed_task_kind: task.kind,
      last_completed_task_at: task.updated_at,
      last_workflow_signal: resolvedEventName || null,
      execution_iteration: nextIteration,
      plan_artifact: proposalArtifact ?? (existingContext as GoalLoopContext).plan_artifact ?? null,
      base_name: (existingContext as GoalLoopContext).base_name ?? deriveBaseNameFromArtifact(proposalArtifact)
    }
  };
}

function resolveRecordedWorkflowSignal(task: TaskRecord): string {
  const acceptedSignals = Array.isArray(task.payload.accepted_signals)
    ? task.payload.accepted_signals.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (acceptedSignals.length === 0) {
    return task.outcome?.workflow_signal ?? "";
  }

  const candidates = [
    task.outcome?.workflow_signal,
    task.outcome?.machine_status,
    ...readWorkflowSignalCandidates(task.outcome?.raw_output)
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && acceptedSignals.includes(candidate)) {
      return candidate;
    }
  }

  return "";
}

function readWorkflowSignalCandidates(rawOutput?: string): Array<string | undefined> {
  if (typeof rawOutput !== "string" || rawOutput.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(extractJsonObject(rawOutput)) as Record<string, unknown>;
    return [
      typeof parsed.workflow_signal === "string" ? parsed.workflow_signal : undefined,
      typeof parsed.status === "string" ? parsed.status : undefined,
      typeof parsed.machine_status === "string" ? parsed.machine_status : undefined
    ];
  } catch {
    return [];
  }
}

function extractJsonObject(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (trimmed.startsWith("```")) {
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }
  }
  return trimmed;
}

export function buildWorkflowTaskInput(workflow: Workflow, task: TaskInput): TaskInput {
  return {
    ...task,
    source: `workflow:${workflow.id}:${workflow.current_state}`,
    payload: {
      ...task.payload,
      workflow_id: workflow.id,
      workflow_template: workflow.template,
      workflow_state: workflow.current_state,
      workflow_instance_key: workflow.instance_key
    }
  };
}

function getExecutionIteration(ctx: GoalLoopContext): number {
  return typeof ctx.execution_iteration === "number" && ctx.execution_iteration > 0
    ? ctx.execution_iteration
    : 1;
}

function toGoalLoopBaseName(ctx: GoalLoopContext): string {
  if (ctx.base_name) {
    return ctx.base_name;
  }
  if (ctx.plan_artifact) {
    const derived = deriveBaseNameFromArtifact(ctx.plan_artifact);
    if (derived) {
      return derived;
    }
  }
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const summary = (ctx.summary ?? "workflow-goal")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow-goal";
  return `${timestamp}-${summary}`;
}

function getGoalLoopPlanArtifact(ctx: GoalLoopContext): string {
  return ctx.plan_artifact ?? `plans/${toGoalLoopBaseName(ctx)}-plan.md`;
}

function getGoalLoopExecuteArtifact(ctx: GoalLoopContext): string {
  return `reports/${toGoalLoopBaseName(ctx)}-execute-${getExecutionIteration(ctx)}.md`;
}

function getGoalLoopVerifyArtifact(ctx: GoalLoopContext): string {
  return `reports/${toGoalLoopBaseName(ctx)}-verify-${getExecutionIteration(ctx)}.md`;
}

function deriveBaseNameFromArtifact(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const filename = value.split("/").pop() ?? "";
  if (filename.endsWith("-plan.md")) {
    return filename.slice(0, -"-plan.md".length);
  }
  return null;
}
