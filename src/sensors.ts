import type { Database } from "bun:sqlite";
import {
  enqueueTask,
  getWorkflowByInstanceKey,
  insertWorkflow,
  recordEvent
} from "./db";
import { recordSensorEvent, updateSensorEventResult } from "./sensor-events";
import type { RuntimeConfig, SensorEventInput, SensorEventRecord } from "./types";
import { getTemplateByName } from "./workflows";

export function processSensorEvent(
  db: Database,
  config: RuntimeConfig,
  input: SensorEventInput
): { accepted: boolean; task_id: string | null; workflow_id: number | null; event: SensorEventRecord | null } {
  const workflowTemplate = input.proposed_workflow ? getTemplateByName(input.proposed_workflow.template) : null;
  if (input.proposed_workflow && !workflowTemplate) {
    throw new Error(`unknown workflow template: ${input.proposed_workflow.template}`);
  }

  const event = recordSensorEvent(db, input);
  if (!event) {
    return { accepted: false, task_id: null, workflow_id: null, event: null };
  }

  let taskId: string | null = null;
  let workflowId: number | null = null;

  if (input.proposed_workflow) {
    const existing = getWorkflowByInstanceKey(db, input.proposed_workflow.instance_key);
    if (existing) {
      workflowId = existing.id;
      recordEvent(db, "sensor_workflow_deduped", null, {
        sensor_event_id: event.sensor_event_id,
        workflow_id: existing.id,
        instance_key: input.proposed_workflow.instance_key
      });
    } else {
      workflowId = insertWorkflow(db, {
        template: input.proposed_workflow.template,
        instance_key: input.proposed_workflow.instance_key,
        current_state: input.proposed_workflow.state ?? workflowTemplate?.initialState ?? "initial",
        context_json: input.proposed_workflow.context ? JSON.stringify(input.proposed_workflow.context) : null
      });
      recordEvent(db, "sensor_workflow_created", null, {
        sensor_event_id: event.sensor_event_id,
        workflow_id: workflowId,
        instance_key: input.proposed_workflow.instance_key
      });
    }
  }

  if (input.proposed_task) {
    const task = enqueueTask(db, config, input.proposed_task);
    taskId = task.task_id;
    recordEvent(db, "sensor_task_created", task.task_id, {
      sensor_event_id: event.sensor_event_id,
      sensor_id: input.sensor_id,
      event_id: input.event_id
    });
  }

  const updated = updateSensorEventResult(db, event.sensor_event_id, { taskId, workflowId });
  return { accepted: true, task_id: taskId, workflow_id: workflowId, event: updated };
}
