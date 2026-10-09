const $ = (id) => document.getElementById(id);

const RING_C = 2 * Math.PI * 57;
const HOLD_MS = 3000;
const FRAMED = (() => {
  try {
    return window.top !== window.self;
  } catch (_) {
    return true;
  }
})();

const ui = {
  page: $("page"),
  intro: $("intro"),
  title: $("title"),
  subtitle: $("subtitle"),
  dial: $("dial"),
  arc: $("ringArc"),
  time: $("dialTime"),
  dialLabel: $("dialLabel"),
  task: $("task"),
  taskKicker: $("taskKicker"),
  taskText: $("taskText"),
  primary: $("primaryBtn"),
  primaryText: $("primaryText"),
  bypass: $("bypassLink"),
  hold: $("holdBtn"),
  holdText: $("holdText"),
  holdHint: $("holdHint"),
  strict: $("strictMsg")
};

const state = {
  target: readTarget(),
  session: Object.assign({}, IDLE_SESSION),
  settings: Object.assign({}, DEFAULTS),
  tasks: [],
  loaded: false,
  mode: "",
  canEscape: false,
  holdOpen: false,
  ticker: 0,
  ringKey: "",
  nudged: null,
  holdTimer: 0,
  ending: false,
  loadSeq: 0
};

ui.arc.style.strokeDasharray = `${RING_C} ${RING_C}`;

init();

async function init() {
  const reveal = setTimeout(markReady, 800);
  bind();
  render();
  try {
    await load();
  } catch (_) {}
  clearTimeout(reveal);
  markReady();
  reconcile();
}

function markReady() {
  if (ui.page.classList.contains("is-ready")) return;
  ui.page.classList.add("is-ready");
  requestAnimationFrame(() => ui.intro.setAttribute("aria-live", "polite"));
}

function readTarget() {
  const href = location.href;
  const at = href.indexOf("#");
  const raw = at < 0 ? "" : href.slice(at + 1).trim();
  if (!raw) return { url: "", host: "", label: "" };
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const web = u.protocol === "http:" || u.protocol === "https:";
    return { url: web && host ? u.href : "", host, label: displayDomain(host) };
  } catch (_) {
    return { url: "", host: "", label: "" };
  }
}

function listed(host, settings) {
  return !!host && blockedSites(settings).some((d) => host === d || host.endsWith("." + d));
}

async function load() {
  const seq = ++state.loadSeq;
  const [session, settings, tasks] = await Promise.all([getSession(), getSettings(), getTasks()]);
  if (seq !== state.loadSeq) return;
  state.session = session;
  state.settings = settings;
  state.tasks = tasks;
  state.loaded = true;
  render();
}

async function reconcile() {
  await send("GET_STATE");
  await load().catch(() => {});
}

function refresh() {
  load().catch(() => {});
  reconcile();
}

function send(type) {
  return Promise.resolve()
    .then(() => api.runtime.sendMessage({ type }))
    .catch(() => null);
}

function modeOf(session, settings) {
  if (!state.loaded) return "pending";
  if (state.target.host && !listed(state.target.host, settings)) return "off";
  if (session.phase === "focus" && session.started) return "focus";
  if (settings.blockMode === "always") return "always";
  return "off";
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function show(el, on) {
  el.classList.toggle("hidden", !on);
}

function render() {
  const { session, settings, target } = state;
  applyAppearance(settings);
  document.body.setAttribute("data-phase", session.phase || "idle");

  const mode = modeOf(session, settings);
  const locked = mode === "focus" && isFocusLocked(session, settings);
  const modeChanged = mode !== state.mode;
  state.mode = mode;
  ui.page.setAttribute("data-mode", mode);

  const name = listed(target.host, settings) ? target.label : target.host;
  const blockedTitle = name ? `${name} is blocked` : "This site is blocked";
  const title = mode === "off" ? "You’re clear" : blockedTitle;
  setText(ui.title, title);
  ui.title.classList.toggle("is-long", mode !== "off" && name.length > 24);
  if (document.title !== title) document.title = title;
  const subtitle = subtitleFor(mode, session, settings);
  setText(ui.subtitle, subtitle);
  show(ui.subtitle, !!subtitle);

  show(ui.dial, mode === "focus");
  show(ui.task, mode === "focus");
  renderTask();

  if (mode === "off") {
    setText(ui.primaryText, target.url ? `Continue to ${name}` : "Close tab");
  } else {
    setText(ui.primaryText, "Back to studying");
  }

  const always = settings.blockMode === "always";
  setText(ui.bypass, mode === "focus" ? "I need to stop early" : "I need this site now");
  setText(ui.holdText, mode === "focus" ? "Hold to end focus" : "Hold to turn off blocking");
  setText(ui.holdHint, holdHintFor(mode, always));

  const focused = document.activeElement;
  state.canEscape = (mode === "focus" || mode === "always") && !locked && !FRAMED;
  if (!state.canEscape || modeChanged) resetHold();
  paintEscape();
  show(ui.strict, locked);
  restoreFocus(focused);

  tick();
  syncTicker();
}

function subtitleFor(mode, session, settings) {
  if (mode === "pending") return "";
  if (mode === "off" && state.target.host && !listed(state.target.host, settings)) return "This site isn’t on your block list.";
  if (mode === "focus") {
    if (!session.running || !session.endTime) return "Your focus block is paused.";
    const at = fmtTime(session.endTime);
    if (settings.blockMode === "always") return `Your focus block ends at ${at}. Always-on blocking stays on after that.`;
    return `Back at ${at}, when this focus block ends.`;
  }
  if (mode === "always") return "Always-on blocking is on. You can change it in Settings.";
  if (session.phase === "idle") return "Blocking is off right now.";
  const onBreak = (session.phase === "short" || session.phase === "long") && session.started;
  if (onBreak && session.running && session.endTime) return `Blocking is off for your break, until ${fmtTime(session.endTime)}.`;
  if (onBreak) return "Blocking is off for your break.";
  return "Blocking is off until you start your next focus block.";
}

function holdHintFor(mode, always) {
  if (mode === "focus" && always) return "Press and hold for 3 seconds.\nThis also turns off always-on blocking.";
  if (mode === "always") return "Press and hold for 3 seconds.\nBlocking then runs only during focus blocks.";
  return "Press and hold for 3 seconds.";
}

function renderTask() {
  const next = state.tasks.find((t) => t && !t.done && String(t.text || "").trim());
  show(ui.taskKicker, !!next);
  ui.taskText.classList.toggle("is-empty", !next);
  setText(ui.taskText, next ? String(next.text).trim() : "Pick one thing to finish before your break.");
}

function paintEscape() {
  const open = state.canEscape && state.holdOpen;
  show(ui.bypass, state.canEscape && !state.holdOpen);
  show(ui.hold, open);
  show(ui.holdHint, open);
}

function restoreFocus(focused) {
  if (!focused || (focused !== ui.bypass && focused !== ui.hold)) return;
  if (focused.getClientRects().length) return;
  (state.canEscape ? ui.bypass : ui.primary).focus({ preventScroll: true });
}

function syncTicker() {
  const want = state.mode === "focus" && !!state.session.running;
  if (want && !state.ticker) state.ticker = setInterval(tick, 1000);
  if (!want && state.ticker) {
    clearInterval(state.ticker);
    state.ticker = 0;
  }
}

function tick() {
  if (state.mode !== "focus") return;
  const s = state.session;
  const running = !!s.running && !!s.endTime;
  const total = s.duration || phaseDurationSec("focus", state.settings) || 1;
  const rem = remainingSeconds(s);
  const clock = fmtClock(rem);
  setText(ui.time, clock);
  ui.time.classList.toggle("is-long", clock.length > 5);
  setText(ui.dialLabel, running ? "left in focus" : "paused");
  paintRing(Math.min(1, Math.max(0, rem / total)), running, `${s.phase}|${s.endTime}|${running}`);
  if (running && rem <= 0 && state.nudged !== s.endTime) {
    state.nudged = s.endTime;
    reconcile();
  }
}

function paintRing(frac, running, key) {
  const arc = ui.arc;
  const keep = running && key === state.ringKey;
  state.ringKey = key;
  if (!keep) arc.classList.remove("is-live");
  arc.style.strokeDashoffset = String(-(1 - frac) * RING_C);
  arc.classList.toggle("is-empty", frac <= 0);
  arc.classList.toggle("is-paused", !running);
  if (!keep && running) {
    arc.getBoundingClientRect();
    arc.classList.add("is-live");
  }
}

function bind() {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.session || changes.settings || changes.tasks) load().catch(() => {});
  });
  watchAppearance(() => render());

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) refresh();
  });
  window.addEventListener("hashchange", () => {
    state.target = readTarget();
    render();
  });

  ui.primary.addEventListener("click", onPrimary);

  ui.bypass.addEventListener("click", () => {
    if (!state.canEscape) return;
    state.holdOpen = true;
    paintEscape();
    ui.hold.focus({ preventScroll: true });
  });

  ui.hold.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startHold();
  });
  ui.hold.addEventListener("pointerup", cancelHold);
  ui.hold.addEventListener("pointerleave", cancelHold);
  ui.hold.addEventListener("pointercancel", cancelHold);
  ui.hold.addEventListener("contextmenu", (e) => e.preventDefault());
  ui.hold.addEventListener("blur", cancelHold);
  ui.hold.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) startHold();
    } else if (e.key === "Escape") {
      e.preventDefault();
      resetHold();
      paintEscape();
      ui.bypass.focus({ preventScroll: true });
    }
  });
  ui.hold.addEventListener("keyup", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      cancelHold();
    }
  });
}

function onPrimary() {
  if (state.mode === "off") {
    if (state.target.url) location.replace(state.target.url);
    else closeTab();
    return;
  }
  if (history.length > 1) history.back();
  else closeTab();
}

async function closeTab() {
  try {
    const tab = await api.tabs.getCurrent();
    if (tab && tab.id != null) {
      await api.tabs.remove(tab.id);
      return;
    }
  } catch (_) {}
  location.replace("about:blank");
}

function startHold() {
  if (state.holdTimer || state.ending || !state.canEscape) return;
  ui.hold.classList.add("is-holding");
  state.holdTimer = setTimeout(() => {
    state.holdTimer = 0;
    endEarly();
  }, HOLD_MS);
}

function cancelHold() {
  if (state.ending) return;
  if (state.holdTimer) clearTimeout(state.holdTimer);
  state.holdTimer = 0;
  ui.hold.classList.remove("is-holding");
}

function resetHold() {
  if (state.holdTimer) clearTimeout(state.holdTimer);
  state.holdTimer = 0;
  state.holdOpen = false;
  ui.hold.classList.remove("is-holding");
  if (!state.ending) ui.hold.removeAttribute("aria-disabled");
}

async function endEarly() {
  if (FRAMED) return;
  state.ending = true;
  ui.hold.setAttribute("aria-disabled", "true");
  try {
    const [session, settings] = await Promise.all([getSession(), getSettings()]);
    if (!isFocusLocked(session, settings)) {
      if (session.phase === "focus" && session.started) await send("RESET");
      if (settings.blockMode === "always") await saveSettings({ blockMode: "duringFocus" });
    }
    await send("SETTINGS_CHANGED");
  } catch (_) {}
  state.ending = false;
  ui.hold.removeAttribute("aria-disabled");
  state.mode = "";
  await load().catch(() => render());
}
