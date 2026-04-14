const state = {
  snapshots: [],
  events: [],
  activeTab: "workflows"
};

function qs(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function compactText(value, limit = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "No summary available.";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function badge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function openDetails(title, subtitle, payload) {
  qs("detail-title").textContent = title;
  qs("detail-subtitle").textContent = subtitle;
  qs("detail-body").textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  qs("detail-dialog").showModal();
}

function bindDetailButtons() {
  Array.from(document.querySelectorAll("[data-detail-title]")).forEach((button) => {
    button.addEventListener("click", () => {
      const title = button.getAttribute("data-detail-title") || "Details";
      const subtitle = button.getAttribute("data-detail-subtitle") || "";
      const payload = button.getAttribute("data-detail-json") || "{}";
      try {
        openDetails(title, subtitle, JSON.parse(payload));
      } catch {
        openDetails(title, subtitle, payload);
      }
    });
  });
}

function setActiveTab(tabName) {
  state.activeTab = tabName;
  Array.from(document.querySelectorAll(".tab-button")).forEach((button) => {
    const isActive = button.getAttribute("data-tab") === tabName;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  Array.from(document.querySelectorAll(".tab-panel")).forEach((panel) => {
    const isActive = panel.id === `tab-${tabName}`;
    panel.classList.toggle("is-active", isActive);
    panel.hidden = !isActive;
  });
  qs("workspace-meta").textContent = `Viewing ${tabName}`;
}

function bindTabs() {
  Array.from(document.querySelectorAll(".tab-button")).forEach((button) => {
    button.addEventListener("click", () => {
      const tabName = button.getAttribute("data-tab");
      if (!tabName) {
        return;
      }
      setActiveTab(tabName);
    });
  });
}

function renderStatus(payload) {
  qs("runtime-name").textContent = payload.runtime_name || "Lumen runtime";
  const runtimeState = payload.status?.runtime_state || "idle";
  const runtimeBadge = qs("runtime-state");
  runtimeBadge.textContent = runtimeState;
  runtimeBadge.className = `badge ${runtimeState}`;

  const counts = payload.status?.counts || {};
  qs("count-queued").textContent = String(counts.queued ?? 0);
  qs("count-running").textContent = String(counts.running ?? 0);
  qs("count-completed").textContent = String(counts.completed ?? 0);
  qs("count-blocked").textContent = String(counts.blocked ?? 0);

  const lastEvent = payload.status?.last_event;
  qs("last-event").textContent = lastEvent
    ? `${lastEvent.event_type} at ${formatTime(lastEvent.created_at)}`
    : "No events yet";

  const summaryBits = [
    `${counts.running ?? 0} running`,
    `${counts.queued ?? 0} queued`,
    `${counts.blocked ?? 0} blocked`
  ];
  if (lastEvent?.event_type) {
    summaryBits.push(`last event ${lastEvent.event_type}`);
  }
  qs("hero-summary").textContent = `Runtime is ${runtimeState}. ${summaryBits.join(" • ")}.`;
}

function renderWorkflows(workflows) {
  qs("workflow-count").textContent = `${workflows.length} total`;
  qs("workflow-list").innerHTML = workflows.map((workflow) => {
    const currentState = workflow.completed_at ? "completed" : workflow.current_state;
    const subtitle = `${workflow.template} • updated ${formatTime(workflow.updated_at)}`;
    return `
      <article class="card">
        <div class="card-head">
          <div class="truncate">
            <strong class="truncate">${escapeHtml(workflow.instance_key)}</strong>
            <p class="subtext">${escapeHtml(subtitle)}</p>
          </div>
          ${badge(currentState)}
        </div>
        <p class="summary-line">Current state: ${escapeHtml(currentState)}</p>
        <div class="card-actions">
          <span class="muted">${workflow.context ? Object.keys(workflow.context).length : 0} context keys</span>
          <button
            type="button"
            class="link-button"
            data-detail-title="Workflow: ${escapeHtml(workflow.instance_key)}"
            data-detail-subtitle="${escapeHtml(subtitle)}"
            data-detail-json="${escapeHtml(JSON.stringify(workflow))}"
          >View details</button>
        </div>
      </article>
    `;
  }).join("") || `<p class="muted">No workflows recorded.</p>`;
  bindDetailButtons();
}

function renderTasks(tasks) {
  const runningTasks = tasks.filter((task) => task.status === "running");
  const workflowTasks = tasks.filter((task) => task.source?.startsWith("workflow:"));
  const otherTasks = tasks.filter((task) => !task.source?.startsWith("workflow:"));

  qs("running-task-count").textContent = `${runningTasks.length} active`;
  qs("running-task-list").innerHTML = renderTaskCards(
    runningTasks,
    "No running tasks right now."
  );
  qs("workflow-task-list").innerHTML = renderTaskCards(
    workflowTasks,
    "No recent workflow tasks."
  );
  qs("task-list").innerHTML = renderTaskCards(
    otherTasks,
    "No recent non-workflow tasks."
  );
  bindDetailButtons();
}

function renderTaskCards(tasks, emptyMessage) {
  return tasks.map((task) => {
    const title = task.subject || task.kind;
    const subtitle = `${task.kind} • ${task.source} • updated ${formatTime(task.updated_at)}`;
    const summary = compactText(task.operator_summary || task.description || "No summary");
    return `
      <article class="card">
        <div class="card-head">
          <div class="truncate">
            <strong class="truncate">${escapeHtml(title)}</strong>
            <p class="subtext">${escapeHtml(subtitle)}</p>
          </div>
          ${badge(task.status)}
        </div>
        <p class="summary-line">${escapeHtml(summary)}</p>
        <div class="card-actions">
          <span class="muted">attempt ${escapeHtml(task.attempt_count)}/${escapeHtml(task.max_attempts)}</span>
          <button
            type="button"
            class="link-button"
            data-detail-title="Task: ${escapeHtml(title)}"
            data-detail-subtitle="${escapeHtml(subtitle)}"
            data-detail-json="${escapeHtml(JSON.stringify(task))}"
          >View details</button>
        </div>
      </article>
    `;
  }).join("") || `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
}

function renderEvents(events) {
  state.events = events.slice(-12);
  qs("event-list").innerHTML = state.events.slice().reverse().map((event) => {
    const detailSummary = compactText(JSON.stringify(event.detail || {}), 90);
    return `
      <article class="card">
        <div class="card-head">
          <strong class="truncate">${escapeHtml(event.event_type)}</strong>
          <span class="muted">${formatTime(event.created_at)}</span>
        </div>
        <p class="summary-line">${escapeHtml(detailSummary)}</p>
        <div class="card-actions">
          <span class="muted">#${escapeHtml(event.id)}</span>
          <button
            type="button"
            class="link-button"
            data-detail-title="Event: ${escapeHtml(event.event_type)}"
            data-detail-subtitle="Recorded ${escapeHtml(formatTime(event.created_at))}"
            data-detail-json="${escapeHtml(JSON.stringify(event))}"
          >View details</button>
        </div>
      </article>
    `;
  }).join("") || `<p class="muted">No recent events.</p>`;
  bindDetailButtons();
}

function fillSnapshotSelect(select, snapshots) {
  select.innerHTML = snapshots.map((snapshot) => `
    <option value="${escapeHtml(snapshot.path)}">${escapeHtml(formatTime(snapshot.captured_at))} • ${escapeHtml(snapshot.name)}</option>
  `).join("");
}

function renderSnapshots(snapshots) {
  state.snapshots = snapshots;
  const before = qs("snapshot-before");
  const after = qs("snapshot-after");
  fillSnapshotSelect(before, snapshots);
  fillSnapshotSelect(after, snapshots);
  if (snapshots.length > 1) {
    before.selectedIndex = 1;
    after.selectedIndex = 0;
  }
}

async function loadArtifacts(path = "") {
  const response = await fetch(`/api/artifacts${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  const payload = await response.json();
  qs("artifact-path").textContent = `state/artifacts/${payload.path || ""}`;

  if (payload.type === "file") {
    await loadArtifactFile(payload.path);
    return;
  }

  qs("artifact-browser").innerHTML = (payload.entries || []).map((entry) => `
    <div class="artifact-entry">
      <button type="button" data-path="${escapeHtml(entry.path)}" data-type="${escapeHtml(entry.type)}">
        <span class="truncate">${entry.type === "directory" ? "DIR" : "FILE"} ${escapeHtml(entry.name)}</span>
      </button>
      <span class="muted">${formatTime(entry.updated_at)}</span>
    </div>
  `).join("") || `<p class="muted">No artifacts yet.</p>`;

  Array.from(qs("artifact-browser").querySelectorAll("button[data-path]")).forEach((button) => {
    button.addEventListener("click", async () => {
      const targetPath = button.getAttribute("data-path");
      const type = button.getAttribute("data-type");
      if (!targetPath) return;
      if (type === "directory") {
        await loadArtifacts(targetPath);
        return;
      }
      await loadArtifactFile(targetPath);
    });
  });
}

async function loadArtifactFile(targetPath) {
  const response = await fetch(`/api/artifact?path=${encodeURIComponent(targetPath)}`);
  const payload = await response.json();
  qs("artifact-content").textContent = payload.content || "Empty artifact.";
}

function summarizeReport(report) {
  if (!report) {
    return "No report loaded.";
  }
  const lines = [
    `Completed delta: ${report.completed_task_delta?.delta ?? 0}`,
    `Queued delta: ${report.queued_task_delta?.delta ?? 0}`,
    `New artifacts: ${(report.new_artifacts_created || []).length}`,
    `Workflow changes: ${(report.workflow_state_changes || []).length}`,
    `Blocked or retryable: ${(report.blocked_or_retryable_tasks || []).length}`,
    `Ended idle: ${report.ended_idle ? "yes" : "no"}`
  ];
  return lines.join("\n");
}

async function loadReport() {
  const before = qs("snapshot-before").value;
  const after = qs("snapshot-after").value;
  if (!before || !after) {
    qs("report-view").textContent = "Need two snapshots to compare.";
    return;
  }
  const response = await fetch(`/api/report?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`);
  const payload = await response.json();
  const report = payload.report || payload;
  qs("report-view").textContent = summarizeReport(report);
  qs("report-view").dataset.rawReport = JSON.stringify(report, null, 2);
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  const payload = await response.json();
  renderStatus(payload);
  renderWorkflows(payload.workflows || []);
  renderTasks(payload.recent_tasks || []);
  renderEvents(payload.events || []);
  renderSnapshots(payload.snapshots || []);
  await loadArtifacts("");
}

function connectStream() {
  const source = new EventSource("/api/stream");
  source.addEventListener("dashboard", (event) => {
    const payload = JSON.parse(event.data);
    renderStatus(payload);
    renderWorkflows(payload.workflows || []);
    renderTasks(payload.recent_tasks || []);
    renderEvents(payload.events || []);
  });
  source.addEventListener("events", (event) => {
    const payload = JSON.parse(event.data);
    renderStatus({ runtime_name: qs("runtime-name").textContent, status: payload.status });
    renderEvents([...state.events, ...(payload.events || [])]);
  });
  source.onerror = () => {
    source.close();
    window.setTimeout(connectStream, 5000);
  };
}

qs("load-report").addEventListener("click", loadReport);
qs("report-view").addEventListener("click", () => {
  const rawReport = qs("report-view").dataset.rawReport;
  if (!rawReport) {
    return;
  }
  openDetails("Snapshot report", "Expanded before/after JSON", JSON.parse(rawReport));
});

bindTabs();
setActiveTab(state.activeTab);
await loadDashboard();
connectStream();
