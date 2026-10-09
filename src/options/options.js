const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

const NUM_FIELDS = {
  focusMin: { min: 1, max: 180, unit: "minutes" },
  shortBreakMin: { min: 1, max: 90, unit: "minutes" },
  longBreakMin: { min: 1, max: 90, unit: "minutes" },
  cyclesBeforeLongBreak: { min: 1, max: 12, unit: "rounds" },
  dailyGoalMin: { min: 0, max: 1440, unit: "minutes" }
};

const SWITCHES = ["autoStartBreaks", "autoStartFocus", "strictMode", "notifications"];

const BLOCK_MODE_HINTS = {
  duringFocus: "Sites are blocked only while a focus block runs.",
  always: "Sites stay blocked, even when no timer is running."
};

const baseTokens = { light: THEMES.light.vars, dark: THEMES.dark.vars };
let settings = Object.assign({}, DEFAULTS);
let stats = {};
const dirty = new Set();

function send(type) {
  try {
    return Promise.resolve(api.runtime.sendMessage({ type })).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ic");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function plural(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

init();

async function init() {
  settings = await getSettings();
  applyAppearance(settings);

  buildThemeCards();
  buildAccentSwatches();
  bindNumbers();
  bindSwitches();
  bindBlockMode();
  bindBlocklist();
  bindData();

  syncControls();
  paintAppearance();

  stats = await getStats();
  renderDashboard();

  api.storage.onChanged.addListener(onStorageChanged);
  watchAppearance((next) => {
    settings = next;
    paintAppearance();
  });

  await initPermissions();

  scrollToHash();
  window.addEventListener("hashchange", scrollToHash);
}

async function onStorageChanged(changes, area) {
  if (area !== "local") return;
  if (changes.settings) {
    settings = await getSettings();
    applyAppearance(settings);
    syncControls();
    renderDashboard();
  }
  if (changes.stats) {
    stats = await getStats();
    renderDashboard();
  }
}

function syncControls() {
  for (const id of Object.keys(NUM_FIELDS)) syncNumber(id);
  for (const id of SWITCHES) $(id).checked = !!settings[id];
  paintBlockMode(settings.blockMode);
  renderBlocklist();
  paintAppearance();
}

function scrollToHash() {
  if (location.hash !== "#stats") return;
  $("stats").scrollIntoView({ block: "start" });
}

function syncNumber(id) {
  const input = $(id);
  if (document.activeElement === input && dirty.has(id)) return;
  dirty.delete(id);
  input.value = settings[id];
  setFieldError(id, "");
}

function setFieldError(id, message) {
  const input = $(id);
  const hint = $(id + "-h");
  if (message) {
    input.setAttribute("aria-invalid", "true");
    hint.textContent = message;
    hint.classList.add("is-error");
  } else {
    input.removeAttribute("aria-invalid");
    hint.textContent = hint.dataset.default || "";
    hint.classList.remove("is-error");
  }
}

function rangeMessage(id) {
  const f = NUM_FIELDS[id];
  return `Enter ${f.min.toLocaleString()} to ${f.max.toLocaleString()} ${f.unit}.`;
}

function validateNumber(id) {
  const input = $(id);
  const f = NUM_FIELDS[id];
  if (input.validity.badInput) return setFieldError(id, rangeMessage(id));
  if (input.value === "") return setFieldError(id, "");
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < f.min || n > f.max) return setFieldError(id, rangeMessage(id));
  setFieldError(id, "");
}

async function commitNumber(id) {
  const input = $(id);
  const f = NUM_FIELDS[id];
  dirty.delete(id);
  const n = input.value === "" || input.validity.badInput ? NaN : Number(input.value);
  if (!Number.isFinite(n)) {
    input.value = settings[id];
    setFieldError(id, "");
    return;
  }
  const value = Math.min(f.max, Math.max(f.min, Math.round(n)));
  input.value = value;
  setFieldError(id, "");
  if (value === settings[id]) return;
  settings = Object.assign({}, settings, { [id]: value });
  settings = await saveSettings({ [id]: value });
  await send("SETTINGS_CHANGED");
}

function bindNumbers() {
  for (const id of Object.keys(NUM_FIELDS)) {
    const input = $(id);
    input.addEventListener("input", () => {
      dirty.add(id);
      validateNumber(id);
    });
    input.addEventListener("change", () => commitNumber(id));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      dirty.delete(id);
      input.value = settings[id];
      setFieldError(id, "");
    });
    input.addEventListener("blur", () => {
      if (dirty.has(id)) {
        commitNumber(id);
        return;
      }
      input.value = settings[id];
      setFieldError(id, "");
    });
  }
}

function bindSwitches() {
  for (const id of SWITCHES) {
    const input = $(id);
    input.addEventListener("change", async () => {
      settings = await saveSettings({ [id]: input.checked });
      await send("SETTINGS_CHANGED");
    });
  }
}

function blockModeButtons() {
  return Array.from($("blockMode").querySelectorAll("button"));
}

function paintBlockMode(value) {
  for (const b of blockModeButtons()) {
    const on = b.dataset.val === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $("blockMode-h").textContent = BLOCK_MODE_HINTS[value] || "";
}

async function chooseBlockMode(value) {
  paintBlockMode(value);
  if (settings.blockMode === value) return;
  settings = await saveSettings({ blockMode: value });
  await send("SETTINGS_CHANGED");
}

function bindBlockMode() {
  const buttons = blockModeButtons();
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => chooseBlockMode(b.dataset.val));
    b.addEventListener("keydown", (e) => {
      let next = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % buttons.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = buttons.length - 1;
      if (next < 0) return;
      e.preventDefault();
      buttons[next].focus();
      chooseBlockMode(buttons[next].dataset.val);
    });
  });
}

function setBlockMessage(text, isError) {
  const msg = $("blockMsg");
  msg.textContent = text;
  msg.classList.toggle("is-error", !!isError);
  if (isError) $("blockInput").setAttribute("aria-invalid", "true");
  else $("blockInput").removeAttribute("aria-invalid");
}

function bindBlocklist() {
  const input = $("blockInput");
  $("blockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    addSite();
  });
  input.addEventListener("input", () => {
    if (input.getAttribute("aria-invalid") === "true" || $("blockMsg").textContent) setBlockMessage("", false);
  });
}

async function addSite() {
  const input = $("blockInput");
  const raw = input.value.trim();
  if (!raw) {
    setBlockMessage("Type a site address, like example.com.", true);
    input.focus();
    return;
  }
  const domain = normalizeDomain(raw);
  if (!domain) {
    setBlockMessage("That isn’t a site address. Try example.com.", true);
    input.focus();
    return;
  }
  const list = blockedSites(await getSettings());
  if (list.includes(domain)) {
    setBlockMessage("Already on the list.", true);
    input.focus();
    return;
  }
  if (list.length >= MAX_BLOCKED_SITES) {
    setBlockMessage(`The list is full at ${MAX_BLOCKED_SITES.toLocaleString()} sites. Remove one to add another.`, true);
    input.focus();
    return;
  }
  list.push(domain);
  settings = await saveSettings({ blocklist: list });
  input.value = "";
  setBlockMessage(`Added ${displayDomain(domain)}.`, false);
  renderBlocklist();
  input.focus();
  await send("SETTINGS_CHANGED");
}

async function removeSite(domain) {
  const list = blockedSites(await getSettings()).filter((d) => d !== domain);
  settings = await saveSettings({ blocklist: list });
  setBlockMessage(`Removed ${displayDomain(domain)}.`, false);
  renderBlocklist();
  await send("SETTINGS_CHANGED");
}

function renderBlocklist() {
  const list = $("blocklist");
  const active = document.activeElement;
  const activeChip = active && active.closest ? active.closest(".chip") : null;
  const hadFocus = !!activeChip && list.contains(activeChip);
  const keepDomain = hadFocus ? activeChip.dataset.domain : null;
  const keepIndex = hadFocus ? Array.prototype.indexOf.call(list.children, activeChip) : -1;
  const sites = blockedSites(settings);

  list.textContent = "";
  for (const domain of sites) {
    const shown = displayDomain(domain);
    const chip = el("li", "chip");
    chip.dataset.domain = domain;
    chip.title = shown === domain ? domain : `${shown} (${domain})`;
    const x = el("button", "chip-x");
    x.type = "button";
    x.setAttribute("aria-label", "Remove " + shown);
    x.append(icon("M17 7 7 17M7 7l10 10"));
    x.addEventListener("click", () => removeSite(domain));
    chip.append(el("span", "chip-name", shown), x);
    list.append(chip);
  }

  if (hadFocus) {
    const buttons = list.querySelectorAll(".chip-x");
    const same = sites.indexOf(keepDomain);
    if (same >= 0) buttons[same].focus();
    else if (buttons.length) buttons[Math.min(keepIndex, buttons.length - 1)].focus();
    else $("blockInput").focus();
  }

  $("blockCount").textContent = sites.length
    ? `${plural(sites.length, "site", "sites")}, subdomains included`
    : "No sites on the list yet.";
}

function previewPalette(base, themeId) {
  const theme = THEMES[themeId];
  if (theme && theme.named) {
    const v = theme.vars;
    return { bg: v["--bg"], surface: v["--surface"], line: v["--separator"], accent: v["--accent"], short: v["--short"], long: v["--long"] };
  }
  const v = baseTokens[base];
  const accent = ACCENTS[settings.accent] || ACCENTS.amber;
  return { bg: v["--bg"], surface: v["--surface"], line: v["--separator"], accent: accent[base], short: v["--short"], long: v["--long"] };
}

function previewLayer(split) {
  const layer = el("span", split ? "tp-layer is-split" : "tp-layer");
  const panel = el("span", "tp-panel");
  panel.append(el("span", "tp-pill"), el("span", "tp-dot s"), el("span", "tp-dot l"));
  layer.append(panel);
  return layer;
}

function paintLayer(layer, p) {
  if (!p) return;
  layer.style.setProperty("--p-bg", p.bg);
  layer.style.setProperty("--p-surface", p.surface);
  layer.style.setProperty("--p-line", p.line);
  layer.style.setProperty("--p-accent", p.accent);
  layer.style.setProperty("--p-short", p.short);
  layer.style.setProperty("--p-long", p.long);
}

function buildThemeCards() {
  const grid = $("themeGrid");
  for (const [id, theme] of Object.entries(THEMES)) {
    const card = el("button", "theme-card");
    card.type = "button";
    card.dataset.theme = id;
    card.setAttribute("aria-pressed", "false");
    const preview = el("span", "tp");
    preview.setAttribute("aria-hidden", "true");
    preview.append(previewLayer(false));
    if (id === "system") preview.append(previewLayer(true));
    card.append(preview, el("span", "tn", theme.name));
    card.addEventListener("click", () => chooseTheme(id));
    grid.append(card);
  }
}

function buildAccentSwatches() {
  const wrap = $("accentSwatches");
  for (const [key, accent] of Object.entries(ACCENTS)) {
    const swatch = el("button", "swatch");
    swatch.type = "button";
    swatch.dataset.accent = key;
    swatch.title = accent.name;
    swatch.setAttribute("aria-label", accent.name + " accent");
    swatch.setAttribute("aria-pressed", "false");
    swatch.addEventListener("click", () => chooseAccent(key));
    wrap.append(swatch);
  }
}

function paintAppearance() {
  const themeId = THEMES[settings.theme] ? settings.theme : "system";
  const named = !!THEMES[themeId].named;
  const base = resolveBase(settings);

  for (const card of $("themeGrid").querySelectorAll(".theme-card")) {
    const id = card.dataset.theme;
    card.setAttribute("aria-pressed", String(id === themeId));
    const layers = card.querySelectorAll(".tp-layer");
    if (id === "system") {
      paintLayer(layers[0], previewPalette("light", id));
      paintLayer(layers[1], previewPalette("dark", id));
    } else {
      paintLayer(layers[0], previewPalette(THEMES[id].base === "dark" ? "dark" : "light", id));
    }
  }

  const accentKey = ACCENTS[settings.accent] ? settings.accent : "amber";
  for (const swatch of $("accentSwatches").querySelectorAll(".swatch")) {
    const key = swatch.dataset.accent;
    swatch.style.setProperty("--sw", ACCENTS[key][base]);
    swatch.setAttribute("aria-pressed", String(key === accentKey));
  }
  $("accentName").textContent = ACCENTS[accentKey].name;
  $("accentRow").classList.toggle("hidden", named);
  const note = $("themeNote");
  note.classList.toggle("hidden", !named);
  note.textContent = named ? `${THEMES[themeId].name} comes with its own accent colour. Pick System, Light or Dark to choose one.` : "";
}

async function chooseTheme(id) {
  if (settings.theme === id) return;
  settings = Object.assign({}, settings, { theme: id });
  applyAppearance(settings);
  paintAppearance();
  settings = await saveSettings({ theme: id });
  await send("SETTINGS_CHANGED");
}

async function chooseAccent(key) {
  if (settings.accent === key) return;
  settings = Object.assign({}, settings, { accent: key });
  applyAppearance(settings);
  paintAppearance();
  settings = await saveSettings({ accent: key });
  await send("SETTINGS_CHANGED");
}

function weekStartDay() {
  try {
    const locale = new Intl.Locale(navigator.language || "en-US");
    const info = typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch (_) {}
  return 1;
}

function longDate(d) {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function dayParts(date) {
  try {
    return dayFmt.formatToParts(date);
  } catch (_) {
    return [{ type: "day", value: String(date.getDate()) }];
  }
}

function monthOf(date) {
  const part = dayParts(date).find((p) => p.type === "month");
  return part ? part.value : "";
}

function dayLabel(label, date, showMonth) {
  label.textContent = "";
  const parts = dayParts(date);
  if (!showMonth) {
    const day = parts.find((p) => p.type === "day");
    label.textContent = day ? day.value : String(date.getDate());
    return;
  }
  for (const part of parts) {
    if (part.type === "day") label.append(part.value);
    else label.append(el("span", "mon", part.value));
  }
}

function renderDashboard() {
  const goalSec = Math.max(0, Number(settings.dailyGoalMin) || 0) * 60;
  const entries = Object.entries(stats || {});

  let totalSec = 0;
  let totalSessions = 0;
  let best = { sec: 0, key: null };
  for (const [key, day] of entries) {
    const sec = (day && day.focusSeconds) || 0;
    totalSec += sec;
    totalSessions += (day && day.sessions) || 0;
    if (sec > best.sec) best = { sec, key };
  }

  const now = new Date();
  const daysIntoWeek = (now.getDay() - weekStartDay() + 7) % 7;
  const weekSec = lastNDays(stats, daysIntoWeek + 1).reduce((a, d) => a + d.focusSeconds, 0);

  renderDuration($("sWeek"), weekSec);
  renderDuration($("sBest"), best.sec);
  if (best.key) {
    const [y, m, d] = best.key.split("-").map(Number);
    $("sBest").parentElement.title = longDate(new Date(y, m - 1, d, 12));
  } else {
    $("sBest").parentElement.removeAttribute("title");
  }
  $("sSessions").textContent = totalSessions.toLocaleString();
  $("allTime").textContent = fmtDuration(totalSec);

  const week = lastNDays(stats, 7);
  const hits = week.filter((d) => (goalSec > 0 ? d.focusSeconds >= goalSec : d.focusSeconds > 0)).length;
  $("sGoalLabel").textContent = goalSec > 0 ? "Goal days (7d)" : "Days focused (7d)";
  const goalValue = $("sGoal");
  goalValue.textContent = String(hits);
  goalValue.append(el("span", "unit", " of 7"));
  goalValue.setAttribute("aria-label", `${hits} of 7 days`);

  renderChart(goalSec);
}

function renderChart(goalSec) {
  const days = lastNDays(stats, 14);
  const scale = Math.max(3600, goalSec, ...days.map((d) => d.focusSeconds));
  const today = todayKey();
  const chart = $("chart14");
  chart.textContent = "";

  days.forEach((d, i) => {
    const col = el("div", "col");
    col.setAttribute("role", "listitem");
    if (d.key === today) col.classList.add("today");
    if (!d.focusSeconds) col.classList.add("zero");

    const wrap = el("div", "bar-wrap");
    const bar = el("div", "bar");
    bar.style.height = ((d.focusSeconds / scale) * 100).toFixed(2) + "%";
    wrap.append(bar);

    const label = el("div", "day");
    label.setAttribute("aria-hidden", "true");
    const monthChange = i === 0 || monthOf(days[i - 1].date) !== monthOf(d.date);
    dayLabel(label, d.date, monthChange);

    const summary = d.focusSeconds
      ? `${longDate(d.date)}: ${fmtDuration(d.focusSeconds)}, ${plural(d.sessions, "session", "sessions")}`
      : `${longDate(d.date)}: no focus time`;
    col.title = summary;
    col.append(wrap, label, el("span", "sr-only", summary));
    chart.append(col);
  });

  const empty = days.every((d) => !d.focusSeconds);
  const showGoal = goalSec > 0 && !empty;
  $("goalKey").classList.toggle("hidden", !showGoal);
  if (showGoal) $("goalKeyText").textContent = "Daily goal " + fmtDuration(goalSec);

  const layer = el("div", "chart-layer");
  layer.setAttribute("aria-hidden", "true");
  layer.append(el("div", "chart-base"));
  if (showGoal) {
    const line = el("div", "goal-line");
    line.style.bottom = ((goalSec / scale) * 100).toFixed(2) + "%";
    layer.append(line);
  }
  if (empty) layer.append(el("p", "chart-empty", "No focus time in the last 14 days."));
  chart.append(layer);
  const wrap = chart.querySelector(".bar-wrap");
  if (wrap && chart.clientHeight) {
    layer.style.bottom = Math.max(0, chart.clientHeight - wrap.offsetTop - wrap.clientHeight) + "px";
  }
}

function bindData() {
  $("exportBtn").addEventListener("click", exportData);
  $("resetStats").addEventListener("click", async () => {
    if (!confirm("Delete all focus history? Your settings and tasks stay. This can’t be undone.")) return;
    await api.storage.local.set({ stats: {} });
    stats = {};
    renderDashboard();
  });
  $("resetAll").addEventListener("click", async () => {
    if (!confirm("Reset everything? This deletes your settings, tasks and focus history and stops the timer. This can’t be undone.")) return;
    await api.storage.local.clear();
    await send("RESET");
    await send("SETTINGS_CHANGED");
    location.reload();
  });
}

async function exportData() {
  const [s, st, tasks] = await Promise.all([getSettings(), getStats(), getTasks()]);
  const data = { app: "Focus Flow", exportedAt: new Date().toISOString(), settings: s, stats: st, tasks };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `focus-flow-${todayKey()}.json`;
  a.hidden = true;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}

async function initPermissions() {
  const banner = $("permBanner");
  if (!api.permissions || !api.permissions.contains) return;
  const origins = ["<all_urls>"];
  const check = async () => {
    let granted = true;
    try {
      granted = await api.permissions.contains({ origins });
    } catch (_) {}
    banner.classList.toggle("hidden", granted);
  };
  $("permGrant").addEventListener("click", async () => {
    let granted = false;
    try {
      granted = await api.permissions.request({ origins });
    } catch (_) {}
    if (!granted) return;
    banner.classList.add("hidden");
    await send("SETTINGS_CHANGED");
  });
  if (api.permissions.onAdded) api.permissions.onAdded.addListener(check);
  if (api.permissions.onRemoved) api.permissions.onRemoved.addListener(check);
  await check();
}
