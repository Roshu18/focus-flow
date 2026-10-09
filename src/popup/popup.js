const $ = (id) => document.getElementById(id);

const RING_C = 2 * Math.PI * 57;

const SVG_NS = $("ringArc").namespaceURI;

const ICONS = {
  lock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ["path", { d: "M8 11V7a4 4 0 0 1 8 0v4" }]],
  unlock: [["rect", { x: 5, y: 11, width: 14, height: 10, rx: 2 }], ["path", { d: "M8 11V7a4 4 0 0 1 7.75-1.4" }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  close: [["path", { d: "M17 7 7 17M7 7l10 10" }]]
};

const ui = {
  tabs: Array.from(document.querySelectorAll('[role="tab"]')),
  settingsBtn: $("settingsBtn"),
  phase: $("phaseLabel"),
  arc: $("ringArc"),
  clock: $("clock"),
  rounds: $("rounds"),
  primary: $("primaryBtn"),
  secondary: $("secondary"),
  skip: $("skipBtn"),
  reset: $("resetBtn"),
  note: $("blockNote"),
  addForm: $("addForm"),
  taskInput: $("taskInput"),
  taskList: $("taskList"),
  taskEmpty: $("taskEmpty"),
  taskFoot: $("taskFoot"),
  taskCount: $("taskCount"),
  clearDone: $("clearDone"),
  todayValue: $("todayValue"),
  goalOf: $("goalOf"),
  goalPct: $("goalPct"),
  goalBar: $("goalBar"),
  sessionLine: $("sessionLine"),
  chart: $("chart"),
  dashboardBtn: $("dashboardBtn")
};

const state = {
  session: Object.assign({}, IDLE_SESSION),
  settings: Object.assign({}, DEFAULTS),
  access: true,
  noteKey: "",
  ringKey: "",
  busy: false,
  refreshing: false,
  tick: 0
};

function svgIcon(name, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.append(node);
  }
  return svg;
}

function plural(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

init();

async function init() {
  try {
    const [session, settings, access] = await Promise.all([getSession(), getSettings(), hasAccess()]);
    state.session = session;
    state.settings = settings;
    state.access = access;
  } catch (_) {}
  applyAppearance(state.settings);
  renderTimer();

  bindTabs();
  bindTimer();
  bindTasks();
  bindLinks();
  listen();
  watchAppearance((settings) => {
    state.settings = settings;
    renderTimer();
  });

  renderTasks();
  renderStats();
  refresh();
  scheduleTick();
}

function listen() {
  api.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.session || changes.settings) {
      let session, settings;
      try {
        [session, settings] = await Promise.all([getSession(), getSettings()]);
      } catch (_) {
        return;
      }
      state.session = session;
      if (changes.settings) {
        state.settings = settings;
        applyAppearance(settings);
        renderStats();
      }
      renderTimer();
      scheduleTick();
    }
    if (changes.tasks) renderTasks();
    if (changes.stats) renderStats();
  });
  if (api.permissions && api.permissions.onAdded) api.permissions.onAdded.addListener(checkAccess);
  if (api.permissions && api.permissions.onRemoved) api.permissions.onRemoved.addListener(checkAccess);
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    accept(await api.runtime.sendMessage({ type: "GET_STATE" }), true);
  } catch (_) {
  } finally {
    state.refreshing = false;
  }
}

function accept(res, withAppearance) {
  if (!res || !res.session || !res.settings) return false;
  state.session = Object.assign({}, IDLE_SESSION, res.session);
  state.settings = res.settings;
  if (withAppearance) applyAppearance(state.settings);
  renderTimer();
  scheduleTick();
  return true;
}

async function command(type) {
  if (state.busy) return;
  state.busy = true;
  try {
    const res = await api.runtime.sendMessage({ type });
    if (!accept(res, false)) await refresh();
  } catch (_) {
    await refresh();
  } finally {
    state.busy = false;
  }
}

function bindTabs() {
  const select = (tab, focus) => {
    for (const t of ui.tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).classList.toggle("is-off", !on);
    }
    if (tab.id === "tab-stats") renderStats();
    if (focus) tab.focus();
  };
  ui.tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (e) => {
      const n = ui.tabs.length;
      let next = -1;
      if (e.key === "ArrowRight") next = (i + 1) % n;
      else if (e.key === "ArrowLeft") next = (i + n - 1) % n;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = n - 1;
      if (next < 0) return;
      e.preventDefault();
      select(ui.tabs[next], true);
    });
  });
}

function bindTimer() {
  ui.primary.addEventListener("click", () => {
    const s = state.session;
    if (s.phase === "idle") command("START");
    else if (s.running) command("PAUSE");
    else command("RESUME");
  });
  ui.skip.addEventListener("click", () => command("SKIP"));
  ui.reset.addEventListener("click", () => command("RESET"));
}

function bindLinks() {
  ui.settingsBtn.addEventListener("click", openSettings);
  ui.dashboardBtn.addEventListener("click", async () => {
    try {
      await api.tabs.create({ url: api.runtime.getURL("src/options/options.html#stats") });
    } catch (_) {}
    window.close();
  });
}

async function openSettings() {
  try {
    await api.runtime.openOptionsPage();
  } catch (_) {}
  window.close();
}

function timerView() {
  const { session, settings } = state;
  const phase = ["focus", "short", "long"].includes(session.phase) ? session.phase : "idle";
  const idle = phase === "idle";
  const running = !idle && !!session.running;
  const started = !idle && (running || !!session.started);
  const duration = idle
    ? phaseDurationSec("focus", settings)
    : session.duration || phaseDurationSec(phase, settings);
  return {
    phase,
    idle,
    running,
    paused: started && !running,
    waiting: !idle && !started,
    isBreak: phase === "short" || phase === "long",
    duration,
    remaining: idle ? duration : remainingSeconds(session)
  };
}

function renderTimer() {
  const v = timerView();
  const { session, settings } = state;
  document.body.dataset.phase = v.phase;

  let label;
  if (v.idle) label = "Ready to focus";
  else if (v.waiting) label = v.isBreak ? `Ready for a ${phaseLabel(v.phase).toLowerCase()}` : "Ready to focus";
  else if (v.paused) label = `${phaseLabel(v.phase)} · Paused`;
  else label = phaseLabel(v.phase);
  if (ui.phase.textContent !== label) ui.phase.textContent = label;
  ui.phase.classList.toggle("is-live", v.running);

  let action;
  if (v.idle) action = "Start focus";
  else if (v.running) action = "Pause";
  else if (v.waiting) action = v.isBreak ? "Start break" : "Start focus";
  else action = v.isBreak ? "Resume break" : "Resume focus";
  if (ui.primary.textContent !== action) ui.primary.textContent = action;
  ui.primary.disabled = false;

  const locked = isFocusLocked(session, settings);
  const showSecondary = !v.idle && !locked;
  if (!showSecondary && ui.secondary.contains(document.activeElement)) ui.primary.focus();
  ui.secondary.classList.toggle("is-off", !showSecondary);
  ui.skip.disabled = !showSecondary;
  ui.reset.disabled = !showSecondary;

  setClock(v.remaining);
  paintRing(v);
  renderRounds(v);
  renderNote(v);
}

function paintRing(v) {
  const visible = !v.idle && !v.waiting;
  const frac = v.duration > 0 ? Math.min(1, Math.max(0, v.remaining / v.duration)) : 0;
  const key = `${v.phase}|${v.running}|${visible}`;
  const animate = v.running && key === state.ringKey;
  state.ringKey = key;
  const arc = ui.arc;
  if (!animate && arc.classList.contains("is-live")) {
    arc.classList.remove("is-live");
    arc.getBoundingClientRect();
  }
  arc.style.strokeDasharray = `${RING_C} ${RING_C}`;
  arc.style.strokeDashoffset = String(-(1 - frac) * RING_C);
  arc.classList.toggle("is-empty", !visible || frac <= 0);
  arc.classList.toggle("is-paused", v.paused);
  if (v.running && !animate) {
    arc.getBoundingClientRect();
    arc.classList.add("is-live");
  }
}

function renderRounds(v) {
  const total = Math.min(12, Math.max(1, Number(state.settings.cyclesBeforeLongBreak) || 4));
  const done = Math.max(0, Number(state.session.completedFocus) || 0);
  let filled = v.idle ? 0 : done % total;
  if (!v.idle && filled === 0 && done > 0 && v.phase === "long") filled = total;
  while (ui.rounds.children.length > total) ui.rounds.lastElementChild.remove();
  while (ui.rounds.children.length < total) ui.rounds.append(document.createElement("span"));
  Array.from(ui.rounds.children).forEach((dot, i) => dot.classList.toggle("on", i < filled));
  const label = v.isBreak
    ? `${filled} of ${total} rounds done`
    : `Round ${Math.min(total, filled + 1)} of ${total}`;
  ui.rounds.setAttribute("aria-label", label);
}

async function hasAccess() {
  try {
    if (api.permissions && api.permissions.contains) {
      return !!(await api.permissions.contains({ origins: ["<all_urls>"] }));
    }
  } catch (_) {}
  return true;
}

async function checkAccess() {
  const ok = await hasAccess();
  if (ok === state.access) return;
  state.access = ok;
  renderNote(timerView());
}

function renderNote(v) {
  const { session, settings } = state;
  const count = blockedSites(settings).length;
  const blocking = isBlocking(session, settings);

  let icon = "lock";
  let text = "";
  const link = blocking && count > 0 && !state.access;
  if (link) text = "Allow site access in Settings to see the block page";
  else if (isFocusLocked(session, settings)) text = "Strict mode: this block runs to the end";
  else if (!count) {
    icon = "unlock";
    text = "Your block list is empty";
  } else if (blocking) text = `${plural(count, "site", "sites")} blocked`;
  else if (v.isBreak) {
    icon = "unlock";
    text = "Sites unblocked for your break";
  } else text = `${plural(count, "site", "sites")} will be blocked during focus`;

  const key = `${link}|${icon}|${text}`;
  if (key === state.noteKey) return;
  state.noteKey = key;

  const note = ui.note;
  const hadFocus = note.contains(document.activeElement);
  note.textContent = "";
  if (link) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link";
    btn.textContent = text;
    btn.addEventListener("click", openSettings);
    note.append(btn);
    if (hadFocus) btn.focus();
    return;
  }
  const span = document.createElement("span");
  span.textContent = text;
  note.append(svgIcon(icon, "ic"), span);
  if (hadFocus) ui.primary.focus();
}

function scheduleTick() {
  clearTimeout(state.tick);
  const s = state.session;
  if (!s.running || s.phase === "idle") return;
  let delay = 1000;
  if (s.endTime) {
    const ms = s.endTime - Date.now();
    delay = ms > 0 ? (ms % 1000) + 20 : 1000;
  }
  state.tick = setTimeout(onTick, delay);
}

function setClock(sec) {
  const text = fmtClock(sec);
  if (ui.clock.textContent !== text) ui.clock.textContent = text;
  ui.clock.classList.toggle("is-long", text.length > 5);
}

function onTick() {
  const s = state.session;
  if (s.running && s.phase !== "idle") {
    const v = timerView();
    setClock(v.remaining);
    paintRing(v);
    if (v.remaining <= 0) refresh();
  }
  scheduleTick();
}

let taskQueue = Promise.resolve();
let rowSeq = 0;

function withTasks(change) {
  const run = taskQueue.catch(() => {}).then(async () => {
    const tasks = cleanTasks(await getTasks());
    const next = change ? change(tasks, taskKeys(tasks)) : null;
    if (next) await saveTasks(next);
    renderTaskList(next || tasks);
    return next || tasks;
  });
  taskQueue = run;
  return run;
}

function cleanTasks(tasks) {
  return tasks.filter((t) => t && typeof t === "object");
}

function taskKeys(tasks) {
  const seen = new Set();
  return tasks.map((t, i) => {
    let key = t.id != null && t.id !== "" ? String(t.id) : `#${i}`;
    if (seen.has(key)) key += `#${i}`;
    seen.add(key);
    return key;
  });
}

function bindTasks() {
  ui.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ui.taskInput.value.trim().replace(/\s+/g, " ");
    ui.taskInput.focus();
    if (!text) return;
    ui.taskInput.value = "";
    withTasks((tasks) => tasks.concat({ id: newId(), text, done: false }))
      .then(() => {
        ui.taskList.scrollTop = ui.taskList.scrollHeight;
      })
      .catch(() => {
        if (!ui.taskInput.value) ui.taskInput.value = text;
      });
  });

  ui.taskList.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    const li = btn && btn.closest(".task");
    if (!li) return;
    const key = li.dataset.key;
    if (btn.classList.contains("check")) {
      withTasks((tasks, keys) =>
        tasks.map((t, i) => (keys[i] === key ? Object.assign({}, t, { done: !t.done }) : t))
      ).catch(() => {});
    } else if (btn.classList.contains("del")) {
      withTasks((tasks, keys) => tasks.filter((_, i) => keys[i] !== key)).catch(() => {});
    }
  });

  ui.clearDone.addEventListener("click", () => {
    ui.taskInput.focus();
    withTasks((tasks) => tasks.filter((t) => !t.done)).catch(() => {});
  });
}

function newId() {
  if (self.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function renderTasks() {
  return withTasks(null).catch(() => {});
}

function buildTaskRow(key) {
  const li = document.createElement("li");
  li.className = "task";
  li.dataset.key = key;

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("role", "checkbox");
  check.append(svgIcon("check"));

  const text = document.createElement("span");
  text.className = "task-text";
  text.id = `task-text-${++rowSeq}`;
  check.setAttribute("aria-labelledby", text.id);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn del";
  del.append(svgIcon("close", "ic"));

  li.append(check, text, del);
  return li;
}

function renderTaskList(tasks) {
  const list = ui.taskList;
  const keys = taskKeys(tasks);
  const keep = new Set(keys);
  const active = document.activeElement;
  const activeRow = active && list.contains(active) ? active.closest(".task") : null;

  let refocus = null;
  if (activeRow && !keep.has(activeRow.dataset.key)) {
    const kind = active.classList.contains("del") ? ".del" : ".check";
    let row = activeRow.nextElementSibling;
    while (row && !keep.has(row.dataset.key)) row = row.nextElementSibling;
    if (!row) {
      row = activeRow.previousElementSibling;
      while (row && !keep.has(row.dataset.key)) row = row.previousElementSibling;
    }
    refocus = row ? row.querySelector(kind) : ui.taskInput;
  }

  const rows = new Map();
  for (const li of Array.from(list.children)) {
    if (keep.has(li.dataset.key) && !rows.has(li.dataset.key)) rows.set(li.dataset.key, li);
    else li.remove();
  }

  tasks.forEach((t, i) => {
    const key = keys[i];
    let li = rows.get(key);
    if (!li) {
      li = buildTaskRow(key);
      rows.set(key, li);
    }
    const done = !!t.done;
    li.classList.toggle("done", done);
    li.querySelector(".check").setAttribute("aria-checked", String(done));
    const text = li.querySelector(".task-text");
    const label = String(t.text || "");
    if (text.textContent !== label) text.textContent = label;
    li.querySelector(".del").setAttribute("aria-label", `Delete: ${label}`);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
  });

  if (refocus) refocus.focus();

  const done = tasks.filter((t) => t.done).length;
  ui.taskCount.textContent = `${done} of ${tasks.length} done`;
  ui.taskEmpty.classList.toggle("hidden", tasks.length > 0);
  ui.taskFoot.classList.toggle("hidden", tasks.length === 0);
  ui.clearDone.classList.toggle("is-off", done === 0);
  ui.clearDone.disabled = done === 0;
}

async function renderStats() {
  let stats = {};
  try {
    stats = await getStats();
  } catch (_) {}
  const settings = state.settings;
  const today = stats[todayKey()] || {};
  const seconds = Math.max(0, Number(today.focusSeconds) || 0);
  const sessions = Math.max(0, Number(today.sessions) || 0);
  const goalSec = Math.max(0, (Number(settings.dailyGoalMin) || 0) * 60);

  renderDuration(ui.todayValue, seconds);
  ui.goalOf.textContent = goalSec > 0 ? ` of ${fmtDuration(goalSec)}` : "";
  const pct = goalSec > 0 ? Math.floor(Math.min(1, seconds / goalSec) * 100) : 0;
  ui.goalPct.textContent = goalSec > 0 ? `${pct}%` : "";
  ui.goalBar.classList.toggle("hidden", goalSec === 0);
  ui.goalBar.setAttribute("aria-valuenow", String(pct));
  ui.goalBar.setAttribute("aria-valuetext", `${fmtDuration(seconds)} of ${fmtDuration(goalSec)}`);
  ui.goalBar.firstElementChild.style.width = `${pct}%`;

  const streak = computeStreak(stats, goalSec);
  let line;
  if (sessions) line = `${plural(sessions, "session", "sessions")} today`;
  else line = seconds ? "No completed sessions yet today" : "No sessions yet today";
  if (streak >= 2) line += ` · ${streak}-day streak`;
  ui.sessionLine.textContent = line;

  renderChart(stats, goalSec);
}

function renderChart(stats, goalSec) {
  const days = lastNDays(stats, 7);
  const labels = weekdayLabels(days.map((d) => d.date));
  const scale = Math.max(3600, goalSec, ...days.map((d) => d.focusSeconds));
  const tKey = todayKey();
  const chart = ui.chart;
  chart.textContent = "";
  const summary = [];

  days.forEach((d, i) => {
    const date = d.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    const col = document.createElement("div");
    col.className = "col";
    if (d.key === tKey) col.classList.add("today");
    if (!d.focusSeconds) col.classList.add("zero");
    col.title = `${date}: ${fmtDuration(d.focusSeconds)}`;
    summary.push(`${date} ${fmtDuration(d.focusSeconds)}`);

    const wrap = document.createElement("div");
    wrap.className = "bar-wrap";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.min(100, (d.focusSeconds / scale) * 100)}%`;
    wrap.append(bar);

    const day = document.createElement("div");
    day.className = "day";
    day.textContent = labels[i];

    col.append(wrap, day);
    chart.append(col);
  });

  if (goalSec > 0) {
    const goal = document.createElement("div");
    goal.className = "goal-line";
    goal.style.setProperty("--goal", String(goalSec / scale));
    goal.style.setProperty("--span", String(days.length));
    chart.querySelector(".bar-wrap").append(goal);
  }

  const goalText = goalSec > 0 ? ` Daily goal ${fmtDuration(goalSec)}.` : "";
  chart.setAttribute("aria-label", `Focus time, last 7 days: ${summary.join(", ")}.${goalText}`);
}
