import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "./types";
import {
  completeWorkflow,
  enqueueTaskIfNew,
  getAllActiveWorkflows,
  getLatestCompletedTaskForSource,
  getLatestTaskForSource,
  recordEvent,
  updateWorkflowState
} from "./db";
import {
  buildWorkflowTaskInput,
  evaluateWorkflow,
  getAutoTransitionKinds,
  getAllowedTransitions,
  getCompletionKinds,
  getTemplateByName,
  resolveCompletedTaskTransition
} from "./workflows";

export function evaluateActiveWorkflows(db: Database, config: RuntimeConfig): { workflowsEvaluated: number; tasksCreated: number } {
  const workflows = getAllActiveWorkflows(db);
  let tasksCreated = 0;

  for (const workflow of workflows) {
    const template = getTemplateByName(workflow.template);
    if (!template) {
      recordEvent(db, "workflow_unknown_template", null, { workflow_id: workflow.id, template: workflow.template });
      continue;
    }

    const source = `workflow:${workflow.id}:${workflow.current_state}`;
    const latestTask = getLatestTaskForSource(db, source);
    const completionKinds = getCompletionKinds(workflow.current_state, template);
    const autoTransitionKinds = getAutoTransitionKinds(workflow.current_state, template);
    const completedTask = getLatestCompletedTaskForSource(
      db,
      source,
      [...new Set([...completionKinds, ...autoTransitionKinds])]
    );

    if (completedTask && completionKinds.includes(completedTask.kind)) {
      completeWorkflow(db, workflow.id);
      recordEvent(db, "workflow_completed_from_task", completedTask.task_id, {
        workflow_id: workflow.id,
        workflow_state: workflow.current_state,
        task_kind: completedTask.kind
      });
      continue;
    }

    if (completedTask && autoTransitionKinds.includes(completedTask.kind)) {
      const existingContext = workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : {};
      const transitionAction = resolveCompletedTaskTransition(workflow, template, completedTask);
      if (transitionAction.type === "transition" && transitionAction.nextState) {
        updateWorkflowState(db, workflow.id, transitionAction.nextState, JSON.stringify({
          ...existingContext,
          ...(transitionAction.contextPatch ?? {})
        }));
        if (Object.keys(getAllowedTransitions(transitionAction.nextState, template)).length === 0
          && getCompletionKinds(transitionAction.nextState, template).length === 0) {
          completeWorkflow(db, workflow.id);
        }
        continue;
      }
    }

    if (latestTask && latestTask.status === "operator_canceled") {
      recordEvent(db, "workflow_state_operator_canceled", latestTask.task_id, {
        workflow_id: workflow.id,
        workflow_state: workflow.current_state
      });
      continue;
    }

    if (latestTask && (latestTask.status === "blocked" || latestTask.status === "permanent_failure")) {
      if (workflow.template === "goal-loop") {
        recordEvent(db, "workflow_state_retry_disabled", latestTask.task_id, {
          workflow_id: workflow.id,
          workflow_state: workflow.current_state,
          prior_task_status: latestTask.status
        });
        continue;
      }
      const existingContext = workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : {};
      const retryCounts = isNumberRecord(existingContext.state_retry_counts) ? existingContext.state_retry_counts : {};
      const retryCount = typeof retryCounts[workflow.current_state] === "number" ? retryCounts[workflow.current_state] : 0;
      if (retryCount >= 2) {
        recordEvent(db, "workflow_state_retry_limit_reached", latestTask.task_id, {
          workflow_id: workflow.id,
          workflow_state: workflow.current_state,
          retry_count: retryCount
        });
        continue;
      }
      updateWorkflowState(db, workflow.id, workflow.current_state, JSON.stringify({
        ...existingContext,
        state_retry_counts: {
          ...retryCounts,
          [workflow.current_state]: retryCount + 1
        }
      }));
      recordEvent(db, "workflow_state_requeued_after_failure", latestTask.task_id, {
        workflow_id: workflow.id,
        workflow_state: workflow.current_state,
        prior_task_status: latestTask.status,
        retry_count: retryCount + 1
      });
    }

    const action = evaluateWorkflow(workflow, template);
    if (action.type === "noop") {
      continue;
    }

    if (action.type === "transition" && action.nextState) {
      const existingContext = workflow.context_json ? JSON.parse(workflow.context_json) as Record<string, unknown> : {};
      const mergedContext = JSON.stringify({
        ...existingContext,
        ...(action.contextPatch ?? {})
      });
      updateWorkflowState(db, workflow.id, action.nextState, mergedContext);
      if (Object.keys(getAllowedTransitions(action.nextState, template)).length === 0
        && getCompletionKinds(action.nextState, template).length === 0) {
        completeWorkflow(db, workflow.id);
      }
      continue;
    }

    if (action.type === "create-task" && action.task) {
      const created = enqueueTaskIfNew(db, config, buildWorkflowTaskInput(workflow, action.task));
      if (created) {
        tasksCreated += 1;
        recordEvent(db, "workflow_task_created", created.task_id, {
          workflow_id: workflow.id,
          workflow_state: workflow.current_state
        });
      }
    }
  }

  return {
    workflowsEvaluated: workflows.length,
    tasksCreated
  };
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
