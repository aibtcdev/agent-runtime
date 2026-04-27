// ── State ──
const state = {
  lastState: null,
  events: [],
  activeFilter: "all",
  searchQuery: "",
  disconnected: false,
  selectedTaskId: null,
  replyParentId: null,
  cachedTasks: [],
  dispatchPaused: false,
  connState: "polling",
  prevTasksHash: "",
  seenEventKeys: {}
};

const MAX_EVENTS = 50;
const API_LIMIT = 50;

// ── Helpers ──
function qs(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compactText(value, limit) {
  limit = limit || 100;
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : text.slice(0, limit - 1) + "...";
}

function taskHash(tasks) {
  if (!tasks.length) return "";
  var h = String(tasks.length);
  for (var i = 0; i < Math.min(tasks.length, 30); i++) {
    var task = tasks[i];
    h += "," + [
      task.task_id,
      task.status || "",
      task.updated_at || "",
      task.last_error || "",
      task.operator_summary || ""
    ].join(":");
  }
  return h;
}

function setConnState(newState) {
  state.connState = newState;
  var el = qs("conn-indicator");
  if (!el) return;
  el.className = "conn-indicator " + newState;
  el.title = {
    connected: "SSE connected",
    reconnecting: "SSE reconnecting",
    polling: "Polling"
  }[newState] || newState;
}

function renderTaskRefs(text) {
  if (!text) return "";
  return escapeHtml(text).replace(/#(\d+)/g, '<a class="ref-link" data-ref-task="$1">#$1</a>');
}

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  return Math.floor(diff / 3600000) + "h ago";
}

function blink(el, cls, duration) {
  el.classList.add(cls);
  setTimeout(function() { el.classList.remove(cls); }, duration);
}

function styleBlink(el, color, duration) {
  el.style.color = color;
  setTimeout(function() { el.style.color = ""; }, duration);
}

// ── Dashboard update helper ──
function applyDashboard(data) {
  var el = qs("runtime-state");
  var prevState = state.lastState;
  state.lastState = data.runtime_state;
  el.textContent = data.runtime_state;
  el.className = "heartbeat-state " + data.runtime_state;
  if (prevState && prevState !== data.runtime_state) blink(el, "blink", 400);

  var counts = data.counts || {};
  qs("count-running").textContent = counts.running != null ? counts.running : 0;
  qs("count-queued").textContent = counts.queued != null ? counts.queued : 0;
  qs("count-blocked").textContent = counts.blocked != null ? counts.blocked : 0;
  qs("count-retryable").textContent = counts.retryable_failure != null ? counts.retryable_failure : 0;
  qs("count-canceled").textContent = counts.operator_canceled != null ? counts.operator_canceled : 0;
  state.dispatchPaused = !!(data.dispatch_paused && data.dispatch_paused.paused);
  var pauseButton = qs("pause-toggle");
  pauseButton.textContent = state.dispatchPaused ? "Resume" : "Pause";
  pauseButton.classList.toggle("is-paused", state.dispatchPaused);

  var countsEl = qs("counts");
  var blockedCount = counts.blocked || 0;
  var retryCount = counts.retryable_failure || 0;
  if (blockedCount > 0) {
    countsEl.classList.add("has-blocked");
    qs("count-blocked").classList.add("danger");
  } else {
    countsEl.classList.remove("has-blocked");
    qs("count-blocked").classList.remove("danger");
  }
  if (retryCount > 0) {
    qs("count-retryable").classList.add("warn");
  } else {
    qs("count-retryable").classList.remove("warn");
  }

  var lastEvent = data.last_event;
  qs("last-event").textContent = lastEvent
    ? lastEvent.event_type + " " + timeAgo(lastEvent.created_at)
    : "no events";

  if (counts.running > 0 || counts.blocked > 0) {
    styleBlink(el, counts.blocked > 0 ? "var(--danger)" : "var(--accent)", 1500);
  }
}

// ── Collapsible Sections ──
function initCollapsible() {
  document.querySelectorAll(".section-header").forEach(function(header) {
    var toggle = function() {
      var sec = header.closest(".section");
      sec.classList.toggle("collapsed");
      header.setAttribute("aria-expanded", !sec.classList.contains("collapsed"));
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", function(e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
}

// ── Filter Tabs ──
function initFilters() {
  document.querySelectorAll(".filter-tab").forEach(function(tab) {
    tab.addEventListener("click", function() {
      document.querySelectorAll(".filter-tab").forEach(function(t) { t.classList.remove("is-active"); });
      tab.classList.add("is-active");
      state.activeFilter = tab.dataset.filter;
      renderTasks();
    });
  });
}

// ── Heartbeat ──
function checkHeartbeat() {
  fetch("/api/heartbeat", { cache: "no-store" }).then(function(res) {
    if (!res.ok) throw new Error("unreachable");
    if (state.disconnected) {
      state.disconnected = false;
      qs("heartbeat").classList.remove("disconnected");
    }
  }).catch(function() {
    if (!state.disconnected) {
      state.disconnected = true;
      qs("heartbeat").classList.add("disconnected");
    }
  });
}

// ── Fetch ──
function fetchState() {
  return fetch("/api/state").then(function(res) { return res.ok ? res.json() : null; }).then(function(data) {
    if (!data) return;
    applyDashboard(data);
  });
}

function fetchTasks() {
  return fetch("/api/tasks?limit=" + API_LIMIT).then(function(res) { return res.ok ? res.json() : null; }).then(function(data) {
    if (!data) return;
    var tasks = data.tasks || [];
    var hash = taskHash(tasks);
    if (hash === state.prevTasksHash) return;

    var changedIds = findChangedTasks(tasks, state.prevTasksHash !== "");
    state.cachedTasks = tasks;
    state.prevTasksHash = hash;

    renderTasks(tasks, changedIds);
  });
}

function findChangedTasks(newTasks, highlightChanges) {
  var changed = new Set();
  var prevMap = state._taskStatusSnapshot || {};
  var currentSet = {};
  for (var i = 0; i < newTasks.length; i++) {
    currentSet[newTasks[i].task_id] = newTasks[i].status || "";
    if (highlightChanges && prevMap[newTasks[i].task_id] !== currentSet[newTasks[i].task_id]) {
      changed.add(newTasks[i].task_id);
    }
  }
  for (var i = 0; i < newTasks.length; i++) {
    if (highlightChanges && !prevMap[newTasks[i].task_id]) changed.add(newTasks[i].task_id);
  }
  state._taskStatusSnapshot = currentSet;
  return changed;
}

function renderTasks(tasks, changedIds) {
  if (!changedIds) changedIds = new Set();
  var nowTasks = [];
  var doneTasks = [];

  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    var filtered =
      state.activeFilter === "all"
      || state.activeFilter === task.status
      || (state.activeFilter === "queued" && task.status === "pending")
      || (state.activeFilter === "blocked" && (task.status === "blocked" || task.status === "retryable_failure"))
      || (state.activeFilter === "completed" && task.status === "operator_canceled");

    if (state.searchQuery) {
      var q = state.searchQuery.toLowerCase();
      var subject = (task.subject || "").toLowerCase();
      var desc = (task.description || "").toLowerCase();
      var summary = (task.operator_summary || "").toLowerCase();
      if (!filtered || !(subject.includes(q) || desc.includes(q) || summary.includes(q))) continue;
    }

    if (filtered) {
      (task.status === "completed" || task.status === "operator_canceled" ? doneTasks : nowTasks).push(task);
    }
  }

  qs("now-count").textContent = nowTasks.length > 0 ? nowTasks.length + " active" : "";
  qs("done-count").textContent = doneTasks.length > 0 ? doneTasks.length + " done" : "";

  var emptyMsg = state.activeFilter === "all" ? "Nothing running" : "No matching tasks";
  qs("now-tasks").innerHTML = nowTasks.length > 0
    ? nowTasks.map(function(t) { return taskCardHTML(t, changedIds.has(t.task_id)); }).join("")
    : "<div class='empty-state'>" + emptyMsg + "</div>";

  var doneEmpty = state.activeFilter === "all" ? "No tasks completed yet" : "No matching tasks";
  qs("done-tasks").innerHTML = doneTasks.length > 0
    ? doneTasks.map(function(t) { return taskCardHTML(t, changedIds.has(t.task_id)); }).join("")
    : "<div class='empty-state'>" + doneEmpty + "</div>";

  // Apply animation class after DOM update
  if (changedIds.size > 0) {
    requestAnimationFrame(function() {
      changedIds.forEach(function(id) {
        var card = document.querySelector('[data-task-id="' + id + '"]');
        if (card) {
          card.classList.add("task-changed");
          setTimeout(function() { card.classList.remove("task-changed"); }, 1300);
        }
      });
    });
  }
}

function taskCardHTML(task, isChanged) {
  var subject = task.subject || task.kind || "Untitled";
  var statusClass = task.status === "retryable_failure" ? "retryable_failure" : task.status;
  var escSubject = escapeHtml(subject);
  var escStatus = escapeHtml(statusClass);
  var escTime = escapeHtml(timeAgo(task.updated_at));
  var isMatch = !state.searchQuery || (
    (task.subject || "").toLowerCase().includes(state.searchQuery) ||
    (task.description || "").toLowerCase().includes(state.searchQuery) ||
    (task.operator_summary || "").toLowerCase().includes(state.searchQuery)
  );
  return "<div class='task-card" + (isChanged ? " task-changed" : "") + "' data-task-id='" + task.task_id + "' tabindex='0'>" +
    "<span class='status-dot " + escStatus + "'></span>" +
    "<span class='task-subject" + (isMatch ? "" : " dimmed") + "'>" + escSubject + "</span>" +
    "<span class='task-time'>" + escTime + "</span>" +
    "</div>";
}

function fetchWorkflows() {
  return fetch("/api/workflows").then(function(res) { return res.ok ? res.json() : null; }).then(function(data) {
    if (!data) return;
    renderWorkflows(data.workflows || []);
  });
}

function renderWorkflows(workflows) {
  var active = workflows.filter(function(w) { return !w.completed_at; });
  if (active.length === 0) {
    qs("now-workflows").innerHTML = "";
    return;
  }
  qs("now-workflows").innerHTML = active.map(function(w) {
    return "<div class='workflow-card' tabindex='0'>" +
      "<span class='workflow-template'>" + escapeHtml(w.template) + "</span>" +
      "<span class='workflow-key'>" + escapeHtml(w.instance_key) + " — " + escapeHtml(w.current_state) + "</span>" +
      "</div>";
  }).join("");
}

function fetchEvents() {
  return fetch("/api/events?limit=" + API_LIMIT).then(function(res) { return res.ok ? res.json() : null; }).then(function(data) {
    if (!data) return;
    var events = dedupEvents(data.events || []);
    renderEvents(events);
  });
}

function dedupEvents(newEvents) {
  var seen = state.seenEventKeys;
  var filtered = [];
  for (var i = 0; i < newEvents.length; i++) {
    var e = newEvents[i];
    var key = eventKey(e);
    if (!seen[key]) {
      seen[key] = e.created_at || String(Date.now());
      filtered.push(e);
    }
  }
  // Evict old entries to keep memory bounded
  var entries = Object.keys(seen).sort();
  if (entries.length > 200) {
    for (var i = 0; i < entries.length - 100; i++) {
      delete seen[entries[i]];
    }
  }
  return filtered;
}

function eventKey(event) {
  return event.id != null
    ? "id:" + event.id
    : [event.created_at, event.event_type, event.task_id || "", event.attempt_id || ""].join("|");
}

function renderEvents(events) {
  var eventList = qs("event-list");
  var atBottom = !eventList || eventList.scrollHeight - eventList.scrollTop - eventList.clientHeight < 60;
  var mergedByKey = {};
  state.events.concat(events).forEach(function(event) {
    mergedByKey[eventKey(event)] = event;
  });
  state.events = Object.keys(mergedByKey)
    .map(function(key) { return mergedByKey[key]; })
    .sort(function(a, b) {
      var aId = a.id != null ? Number(a.id) : null;
      var bId = b.id != null ? Number(b.id) : null;
      if (aId != null && bId != null) return aId - bId;
      return String(a.created_at || "").localeCompare(String(b.created_at || ""));
    })
    .slice(-MAX_EVENTS);

  var velocity = qs("event-velocity");
  if (state.events.length >= 2) {
    var first = new Date(state.events[0].created_at);
    var last = new Date(state.events[state.events.length - 1].created_at);
    var diff = Math.round((last - first) / 1000);
    velocity.textContent = diff > 0 ? state.events.length + " events in " + diff + "s" : state.events.length + " events";
  } else {
    velocity.textContent = state.events.length > 0 ? "1 event" : "";
  }

  qs("event-list").innerHTML = state.events.slice().reverse().map(function(e) {
    return "<div class='event-row'>" +
      "<span class='event-type'>" + escapeHtml(e.event_type) + "</span>" +
      "<span class='event-task'>" + escapeHtml(e.task_id ? "#" + e.task_id.slice(0, 8) : "") + "</span>" +
      "<span class='event-time'>" + escapeHtml(timeAgo(e.created_at)) + "</span>" +
      "</div>";
  }).join("") || "<div class='empty-state'>No events</div>";

  // Auto-scroll event list to keep newest visible if not scrolled up
  if (eventList) {
    if (atBottom) eventList.scrollTop = eventList.scrollHeight;
  }
}

// ── Task Detail ──
function showTaskDetail(taskId) {
  state.selectedTaskId = taskId;
  var task = state.cachedTasks.find(function(t) { return t.task_id === taskId; });
  if (!task) task = state.cachedTasks[0];

  var subject = task.subject || task.kind || "Untitled";
  qs("detail-title").textContent = subject;
  var skillRefs = task.payload && Array.isArray(task.payload.skill_refs)
    ? task.payload.skill_refs.join(", ")
    : "(none)";

  var fields = [
    { label: "ID", value: task.task_id, mono: true },
    { label: "Status", value: task.status.replace(/_/g, " ") },
    { label: "Kind", value: task.kind },
    { label: "Source", value: task.source },
    { label: "Priority", value: String(task.priority) },
    { label: "Attempts", value: task.attempt_count + " / " + task.max_attempts },
    { label: "Profile", value: task.requested_profile },
    { label: "Adapter", value: task.requested_adapter },
    { label: "Started", value: task.started_at },
    { label: "Finished", value: task.finished_at },
    { label: "Created", value: task.created_at },
    { label: "Updated", value: task.updated_at },
    { label: "Last Error", value: task.last_error || "(none)", mono: task.last_error != null },
    { label: "Operator Summary", value: task.operator_summary || "(none)", refs: true },
    { label: "Parent", value: task.payload && task.payload.parent_id ? "#" + task.payload.parent_id.slice(0, 8) : "(none)" },
    { label: "Skill Refs", value: skillRefs },
    { label: "Artifacts", value: task.artifact_paths ? task.artifact_paths.join(", ") : "(none)" }
  ];

  var bodyHTML = "";
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value) {
      var cls = f.mono ? "detail-value monospace" : "detail-value";
      var content = f.refs ? renderTaskRefs(f.value) : escapeHtml(f.value);
      bodyHTML += "<div class='detail-field'>" +
        "<div class='detail-label'>" + escapeHtml(f.label) + "</div>" +
        "<div class='" + cls + "'>" + content + "</div>" +
        "</div>";
    }
  }

  qs("detail-body").innerHTML = bodyHTML;

  var parentId = task.task_id;
  var children = state.cachedTasks.filter(function(t) {
    var p = t.payload && t.payload.parent_id;
    return typeof p === "string" && p === parentId;
  });

  if (children.length > 0) {
    var completed = children.filter(function(t) { return t.status === "completed"; }).length;
    var running = children.filter(function(t) { return t.status === "running"; }).length;
    qs("detail-children").textContent = children.length + " children: " +
      completed + " done, " + running + " running, " + (children.length - completed - running) + " other";
  } else {
    qs("detail-children").textContent = "no children";
  }
  var cancelButton = qs("detail-cancel");
  var cancelable = ["pending", "retryable_failure", "blocked"].includes(task.status);
  cancelButton.hidden = !cancelable && task.status !== "running";
  cancelButton.disabled = !cancelable;
  cancelButton.textContent = task.status === "running" ? "Cancel unavailable while running" : "Cancel";

  var drawer = qs("detail-drawer");
  var backdrop = qs("detail-backdrop");
  drawer.hidden = false;
  requestAnimationFrame(function() {
    drawer.classList.add("drawer-open");
    backdrop.hidden = false;
    requestAnimationFrame(function() {
      backdrop.classList.add("drawer-visible");
    });
  });
}

function hideTaskDetail(preserveReplyContext) {
  preserveReplyContext = preserveReplyContext === true;
  var drawer = qs("detail-drawer");
  var backdrop = qs("detail-backdrop");
  drawer.classList.remove("drawer-open");
  backdrop.classList.remove("drawer-visible");
  state.selectedTaskId = null;
  if (!preserveReplyContext) {
    state.replyParentId = null;
  }
  var input = qs("reply-input");
  if (!preserveReplyContext && (input.value === "" || input.value.indexOf("[re:") === 0)) {
    input.placeholder = "New task...";
  }
  setTimeout(function() {
    if (!drawer.classList.contains("drawer-open")) {
      drawer.hidden = true;
      backdrop.hidden = true;
    }
  }, 260);
}

// ── Reply Bar ──
function initReplyBar() {
  var input = qs("reply-input");
  var sendBtn = qs("reply-send");

  input.addEventListener("input", function() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  sendBtn.addEventListener("click", function() {
    var message = input.value.trim();
    if (!message) return;

    qs("reply-status").textContent = "";
    var skillRefs = parseSkillRefs(message);
    var payload = { message: message };
    if (skillRefs.length > 0) {
      payload.skill_refs = skillRefs;
    }
    if (state.replyParentId) {
      payload.parent_id = state.replyParentId;
      payload.subject = "[re: " + state.replyParentId.slice(0, 8) + "] " + message.slice(0, 120);
    }

    fetch("/api/tasks/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (res.ok) {
        input.value = "";
        input.style.height = "auto";
        state.replyParentId = null;
        qs("reply-status").textContent = "queued";
        hideTaskDetail();
        return Promise.all([fetchState(), fetchTasks(), fetchEvents()]);
      }
      return res.json().then(function(err) { throw err; });
    }).catch(function(err) {
      qs("reply-status").textContent = "Error: " + (err.error || err.message);
    });
  });
}

function parseSkillRefs(message) {
  var refs = [];
  var re = /(^|\s)\/([a-zA-Z][\w-]*)/g;
  var match;
  while ((match = re.exec(message)) !== null) {
    if (refs.indexOf(match[2]) === -1) refs.push(match[2]);
  }
  return refs;
}

// ── Reply button in detail ──
function initDetailReply() {
  qs("detail-reply").addEventListener("click", function() {
    if (!state.selectedTaskId) return;
    var parentId = state.selectedTaskId;
    hideTaskDetail(true);
    state.replyParentId = parentId;
    var input = qs("reply-input");
    input.focus();
    input.placeholder = "Reply...";
    input.value = "[re: " + parentId.slice(0, 8) + "] ";
  });

  qs("detail-close").addEventListener("click", function() { hideTaskDetail(false); });
  qs("detail-backdrop").addEventListener("click", function() { hideTaskDetail(false); });
  qs("detail-cancel").addEventListener("click", function() {
    if (!state.selectedTaskId) return;
    cancelTask(state.selectedTaskId);
  });
}

function cancelTask(taskId) {
  fetch("/api/tasks/" + encodeURIComponent(taskId) + "/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "operator UI cancel" })
  }).then(function(res) {
    if (res.ok) return res.json();
    return res.json().then(function(err) { throw err; });
  }).then(function() {
    hideTaskDetail(false);
    return Promise.all([fetchState(), fetchTasks(), fetchEvents()]);
  }).catch(function(err) {
    qs("detail-children").textContent = "cancel failed: " + (err.error || err.message);
  });
}

function initPauseToggle() {
  qs("pause-toggle").addEventListener("click", function() {
    var nextPaused = !state.dispatchPaused;
    fetch("/api/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: nextPaused, reason: "operator UI" })
    }).then(function(res) {
      if (res.ok) return res.json();
      return res.json().then(function(err) { throw err; });
    }).then(function() {
      return fetchState();
    }).catch(function(err) {
      qs("last-event").textContent = "pause error: " + (err.error || err.message);
    });
  });
}

// ── Search ──
function initSearch() {
  var searchInput = qs("search-input");
  var debounceTimer;

  qs("search-toggle").addEventListener("click", function() {
    var bar = qs("search-bar");
    if (bar.hidden) {
      bar.hidden = false;
      searchInput.focus();
    } else {
      bar.hidden = true;
      searchInput.value = "";
      state.searchQuery = "";
      renderTasks(state.cachedTasks);
    }
  });

  searchInput.addEventListener("input", function(e) {
    clearTimeout(debounceTimer);
    state.searchQuery = e.target.value.trim();
    debounceTimer = setTimeout(function() { renderTasks(state.cachedTasks); }, 200);
  });
}

// ── Event delegation for task cards ──
function initTaskDelegation() {
  document.addEventListener("click", function(e) {
    var card = e.target.closest(".task-card");
    if (card) {
      showTaskDetail(card.dataset.taskId);
      return;
    }
    var link = e.target.closest(".ref-link");
    if (link) {
      e.preventDefault();
      showTaskDetail(link.dataset.refTask);
    }
  });
}

// ── SSE Stream ──
var esInstance = null;

function connectStream() {
  if (esInstance) return;
  esInstance = new EventSource("/api/stream");

  setConnState("reconnecting");

  esInstance.addEventListener("dashboard", function(event) {
    var data = JSON.parse(event.data);
    setConnState("connected");
    applyDashboard(data);
  });

  esInstance.addEventListener("events", function(event) {
    var data = JSON.parse(event.data);
    var prevState = state.lastState;

    var counts = data.status ? data.status.counts : {};
    if (counts.blocked > 0) {
      styleBlink(qs("runtime-state"), "var(--danger)", 1500);
    }
    if (prevState !== (data.status ? data.status.runtime_state : null)) {
      blink(qs("runtime-state"), "blink", 400);
    }

    // Deduplicate SSE events
    var newEvents = dedupEvents(data.events || []).slice(0, MAX_EVENTS);

    if (newEvents.length > 0) {
      renderEvents(newEvents);
    }
  });

  esInstance.onerror = function() {
    setConnState("reconnecting");
    esInstance.close();
    esInstance = null;
    setTimeout(connectStream, 10000);
  };
}

// ── Polling fallback ──
var sseConnected = false;

function startPolling() {
  if (sseConnected) return;
  setInterval(function() {
    Promise.all([fetchState(), fetchTasks(), fetchWorkflows(), fetchEvents(), checkHeartbeat()]);
  }, 3000);
}

// ── Escape key ──
function initEscapeKey() {
  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") {
      var drawer = qs("detail-drawer");
      if (!drawer.hidden) {
        hideTaskDetail(false);
      }
    }
  });
}

// ── Init ──
async function init() {
  setConnState("polling");
  initCollapsible();
  initFilters();
  initReplyBar();
  initDetailReply();
  initPauseToggle();
  initSearch();
  initTaskDelegation();
  initEscapeKey();

  await Promise.all([fetchState(), fetchTasks(), fetchWorkflows(), fetchEvents()]);

  setInterval(checkHeartbeat, 5000);
  checkHeartbeat();

  connectStream();
  startPolling();
}

init();
