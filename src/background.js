if (typeof importScripts === "function") importScripts("lib/common.js");

const ALARM_PHASE_END = "phaseEnd";
const ALARM_TICK = "tick";
const STALE_MS = 60 * 1000;
const BLOCK_RULE_ID = 1;
const LEGACY_RULE_IDS = Array.from({ length: 150 }, (_, i) => i + 1);
const BLOCKED_PAGE = "src/blocked/blocked.html";

let _opQueue = Promise.resolve();
function enqueue(fn) {
  const p = _opQueue.catch(() => {}).then(fn);
  _opQueue = p;
  return p;
}

api.runtime.onInstalled.addListener(() =>
  enqueue(async () => {
    await saveSettings({});
    await sync();
  })
);

if (api.runtime.onStartup) {
  api.runtime.onStartup.addListener(() => enqueue(sync));
}

if (api.permissions && api.permissions.onAdded) {
  api.permissions.onAdded.addListener(() => enqueue(sync));
  api.permissions.onRemoved.addListener(() => enqueue(sync));
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch((err) => {
    console.error("[FocusFlow]", err);
    sendResponse({ error: String(err) });
  });
  return true;
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PHASE_END) {
    enqueue(async () => {
      const session = await getSession();
      if (!session.running || !session.endTime) return;
      if (session.endTime - Date.now() > 1000) {
        await scheduleAlarms(session);
        return;
      }
      await advancePhase(false);
    });
  } else if (alarm.name === ALARM_TICK) {
    enqueue(async () => {
      const [session, settings] = await Promise.all([getSession(), getSettings()]);
      await updateIndicators(session, settings);
    });
  }
});

enqueue(recoverTimer);

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case "GET_STATE": return enqueue(async () => { await recoverTimer(); return getState(); });
    case "START":     return enqueue(startFocus);
    case "PAUSE":     return enqueue(pause);
    case "RESUME":    return enqueue(resume);
    case "RESET":     return enqueue(reset);
    case "SKIP":      return enqueue(skip);
    case "SETTINGS_CHANGED": return enqueue(onSettingsChanged);
    default: return { ok: false };
  }
}

async function sync() {
  if (await recoverTimer()) return;
  const [session, settings] = await Promise.all([getSession(), getSettings()]);
  await applyBlocking(session, settings);
  await updateIndicators(session, settings);
}

async function recoverTimer() {
  const session = await getSession();
  if (!session.running || !session.endTime) return false;
  if (session.endTime <= Date.now()) {
    await advancePhase(false);
    return true;
  }
  const alarm = await api.alarms.get(ALARM_PHASE_END);
  if (!alarm) await scheduleAlarms(session);
  return false;
}

async function getState() {
  const [session, settings] = await Promise.all([getSession(), getSettings()]);
  return { session, settings, remaining: remainingSeconds(session) };
}

async function startFocus() {
  const current = await getSession();
  if (current.phase !== "idle") return getState();
  const settings = await getSettings();
  await enterPhase({ ...IDLE_SESSION }, "focus", settings, true);
  return getState();
}

async function pause() {
  const session = await getSession();
  if (!session.running || session.phase === "idle") return getState();
  session.remaining = remainingSeconds(session);
  session.running = false;
  session.endTime = null;
  session.pausedAt = Date.now();
  await saveSession(session);
  await clearAlarms();
  await updateIndicators(session, await getSettings());
  return getState();
}

async function resume() {
  const session = await getSession();
  if (session.running || session.phase === "idle") return getState();
  session.endTime = Date.now() + (session.remaining || 0) * 1000;
  session.running = true;
  session.started = true;
  session.remaining = 0;
  session.pausedAt = null;
  await saveSession(session);
  await scheduleAlarms(session);
  const settings = await getSettings();
  await applyBlocking(session, settings);
  await updateIndicators(session, settings);
  return getState();
}

async function reset() {
  await recoverTimer();
  const [session, settings] = await Promise.all([getSession(), getSettings()]);
  if (isFocusLocked(session, settings)) return getState();
  if (session.phase === "focus" && session.started) {
    const dur = session.duration || phaseDurationSec("focus", settings);
    const elapsed = dur - remainingSeconds(session);
    if (elapsed > 20) await recordFocus(elapsed, false, focusEndedAt(session));
  }
  const idle = { ...IDLE_SESSION };
  await saveSession(idle);
  await clearAlarms();
  await applyBlocking(idle, settings);
  await updateIndicators(idle, settings);
  return getState();
}

async function skip() {
  if (await recoverTimer()) return getState();
  const [session, settings] = await Promise.all([getSession(), getSettings()]);
  if (isFocusLocked(session, settings)) return getState();
  await advancePhase(true);
  return getState();
}

async function advancePhase(skipped) {
  const settings = await getSettings();
  const session = await getSession();
  if (session.phase === "idle") return;

  const now = Date.now();
  const stale = !skipped && !!session.endTime && now - session.endTime > STALE_MS;

  if (session.phase === "focus") {
    const dur = session.duration || phaseDurationSec("focus", settings);
    if (skipped) {
      const elapsed = dur - remainingSeconds(session);
      if (session.started && elapsed > 20) await recordFocus(elapsed, false, focusEndedAt(session));
      await enterPhase(session, "short", settings, settings.autoStartBreaks);
      return;
    }
    const endedAt = session.endTime ? Math.min(session.endTime, now) : now;
    const { stats, endKey } = await recordFocus(dur, true, endedAt);
    session.completedFocus = (session.completedFocus || 0) + 1;
    const isLong = session.completedFocus % Math.max(1, settings.cyclesBeforeLongBreak) === 0;
    const autoStart = settings.autoStartBreaks && !stale;
    if (!stale) {
      const n = (stats[endKey] || {}).sessions || 0;
      const done = `${n} focus block${n === 1 ? "" : "s"} today.`;
      const mins = isLong ? settings.longBreakMin : settings.shortBreakMin;
      notify(
        isLong ? "Time for a long break" : "Focus block done",
        autoStart ? `${done} Your ${mins}-minute break has started.` : `${done} Start your ${mins}-minute break when you’re ready.`,
        settings
      );
    }
    await enterPhase(session, isLong ? "long" : "short", settings, autoStart);
    return;
  }

  const autoStart = settings.autoStartFocus && !stale;
  if (!skipped && !stale) {
    notify(
      "Break’s over",
      autoStart ? "Your next focus block has started." : "Start your next focus block when you’re ready.",
      settings
    );
  }
  await enterPhase(session, "focus", settings, autoStart);
}

function focusEndedAt(session) {
  if (session.running) return Date.now();
  return Math.min(session.pausedAt || Date.now(), Date.now());
}

async function enterPhase(session, phase, settings, autoStart) {
  session.phase = phase;
  const dur = phaseDurationSec(phase, settings);
  session.duration = dur;
  session.started = !!autoStart;
  session.pausedAt = null;
  if (autoStart) {
    session.running = true;
    session.endTime = Date.now() + dur * 1000;
    session.remaining = 0;
  } else {
    session.running = false;
    session.endTime = null;
    session.remaining = dur;
  }
  await saveSession(session);
  if (session.running) await scheduleAlarms(session);
  else await clearAlarms();
  await applyBlocking(session, settings);
  await updateIndicators(session, settings);
}

async function scheduleAlarms(session) {
  await clearAlarms();
  if (!session.running || !session.endTime) return;
  api.alarms.create(ALARM_PHASE_END, { when: session.endTime });
  const rem = session.endTime - Date.now();
  const nextTick = session.endTime - (Math.ceil(rem / 60000) - 1) * 60000;
  if (nextTick < session.endTime) {
    api.alarms.create(ALARM_TICK, { when: nextTick, periodInMinutes: 1 });
  }
}

async function clearAlarms() {
  await api.alarms.clear(ALARM_PHASE_END);
  await api.alarms.clear(ALARM_TICK);
}

async function onSettingsChanged() {
  const [session, settings] = await Promise.all([getSession(), getSettings()]);
  if (session.phase !== "idle" && !session.running && !session.started) {
    const dur = phaseDurationSec(session.phase, settings);
    if (dur !== session.duration) {
      session.duration = dur;
      session.remaining = dur;
      await saveSession(session);
    }
  }
  await applyBlocking(session, settings);
  await updateIndicators(session, settings);
  return getState();
}

async function applyBlocking(session, settings) {
  await setBlockingRules(isBlocking(session, settings) ? blockedSites(settings) : []);
}

let _dnrWrite = Promise.resolve();
function setBlockingRules(domains) {
  _dnrWrite = _dnrWrite.catch(() => {}).then(() => writeBlockingRules(domains));
  return _dnrWrite;
}

async function hasSiteAccess() {
  if (!api.permissions || !api.permissions.contains) return true;
  try {
    return await api.permissions.contains({ origins: ["<all_urls>"] });
  } catch (_) {
    return false;
  }
}

function blockRule(domains, kind) {
  const condition = { requestDomains: domains, resourceTypes: ["main_frame"] };
  let action;
  if (kind === "withUrl") {
    condition.regexFilter = "^.+$";
    action = { type: "redirect", redirect: { regexSubstitution: api.runtime.getURL(BLOCKED_PAGE) + "#\\0" } };
  } else if (kind === "page") {
    action = { type: "redirect", redirect: { extensionPath: "/" + BLOCKED_PAGE } };
  } else {
    action = { type: "block" };
  }
  return { id: BLOCK_RULE_ID, priority: 1, action, condition };
}

async function writeBlockingRules(domains) {
  const dnr = api.declarativeNetRequest;
  if (!dnr) return;
  let removeRuleIds = LEGACY_RULE_IDS;
  try {
    const existing = await dnr.getDynamicRules();
    removeRuleIds = Array.from(new Set([...existing.map((r) => r.id), BLOCK_RULE_ID]));
  } catch (_) {}
  if (!domains.length) {
    try { await dnr.updateDynamicRules({ removeRuleIds, addRules: [] }); } catch (err) {
      console.error("[FocusFlow] clearing rules failed", err);
    }
    return;
  }
  const kinds = (await hasSiteAccess()) ? ["withUrl", "page", "block"] : ["block"];
  for (const kind of kinds) {
    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules: [blockRule(domains, kind)] });
      return;
    } catch (err) {
      console.error(`[FocusFlow] ${kind} rule rejected`, err);
    }
  }
}

let _iconState = null;
async function setToolbarIcon(state) {
  if (state === _iconState || !api.action.setIcon) return;
  try {
    await api.action.setIcon({
      path: {
        16: `/icons/toolbar/${state}-16.png`,
        24: `/icons/toolbar/${state}-24.png`,
        32: `/icons/toolbar/${state}-32.png`
      }
    });
    _iconState = state;
  } catch (_) {}
}

async function setToolbarTitle(session, mins) {
  if (!api.action.setTitle) return;
  let title = "Focus Flow";
  if (session.phase !== "idle") {
    const left = `${mins} min left`;
    const state = !session.running ? (session.started ? "paused" : "ready to start") : left;
    title = `Focus Flow: ${phaseLabel(session.phase)}, ${state}`;
  }
  try { await api.action.setTitle({ title }); } catch (_) {}
}

async function updateIndicators(session, settings) {
  const waiting = session.phase !== "idle" && !session.running && !session.started;
  const tone = session.phase === "idle" ? "focus" : session.running || waiting ? session.phase : "paused";
  await setToolbarIcon(tone);
  const mins = Math.max(0, Math.ceil(remainingSeconds(session) / 60));
  await setToolbarTitle(session, mins);
  if (session.phase === "idle") {
    await api.action.setBadgeText({ text: "" });
    return;
  }
  await api.action.setBadgeText({ text: String(mins) });
  await api.action.setBadgeBackgroundColor({ color: TOOLBAR_COLORS[session.running ? tone : "idle"] });
  if (api.action.setBadgeTextColor) {
    try { await api.action.setBadgeTextColor({ color: TOOLBAR_COLORS.ink }); } catch (_) {}
  }
}

function notify(title, message, settings) {
  if (!settings.notifications || !api.notifications) return;
  try {
    const p = api.notifications.create({
      type: "basic",
      iconUrl: api.runtime.getURL("icons/icon128.png"),
      title,
      message
    });
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}
