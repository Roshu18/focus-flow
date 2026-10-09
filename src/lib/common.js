const api = (typeof browser !== "undefined" && browser.runtime) ? browser : chrome;

const DEFAULTS = {
  focusMin: 25,
  shortBreakMin: 5,
  longBreakMin: 15,
  cyclesBeforeLongBreak: 4,
  autoStartBreaks: true,
  autoStartFocus: false,
  blockMode: "duringFocus",
  blocklist: [
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "reddit.com",
    "tiktok.com",
    "netflix.com",
    "twitch.tv"
  ],
  dailyGoalMin: 120,
  theme: "system",
  accent: "amber",
  strictMode: false,
  notifications: true
};

const IDLE_SESSION = {
  phase: "idle",
  running: false,
  started: false,
  endTime: null,
  remaining: 0,
  duration: 0,
  completedFocus: 0,
  pausedAt: null
};

const MAX_BLOCKED_SITES = 1000;

const ACCENTS = {
  amber:    { name: "Ochre",    light: "#8F5C17", dark: "#E3A857" },
  clay:     { name: "Clay",     light: "#A04A33", dark: "#EE9C82" },
  rose:     { name: "Rose",     light: "#9E3F5B", dark: "#EC9AB0" },
  plum:     { name: "Plum",     light: "#76488A", dark: "#C9A2DC" },
  graphite: { name: "Graphite", light: "#45423D", dark: "#D9D4CB" }
};

const THEMES = {
  system: { name: "System", base: "auto" },
  light: {
    name: "Light", base: "light",
    vars: {
      "--bg": "#F3F1EC", "--surface": "#FDFCFA", "--surface-2": "#EDEAE3", "--surface-3": "#E3DFD6",
      "--separator": "#E4E0D8", "--control": "#8C8476", "--text": "#1F1C17", "--text-2": "#5C564C",
      "--text-3": "#6B655A", "--accent": "#8F5C17", "--on-accent": "#FFFFFF", "--short": "#2F6E69",
      "--long": "#44598C", "--danger": "#A63A2B", "--success": "#3D7444"
    }
  },
  dark: {
    name: "Dark", base: "dark",
    vars: {
      "--bg": "#141311", "--surface": "#1C1A17", "--surface-2": "#26231F", "--surface-3": "#322E29",
      "--separator": "#2E2B26", "--control": "#7A7368", "--text": "#EEEAE2", "--text-2": "#C7C0B4",
      "--text-3": "#A39C90", "--accent": "#E3A857", "--on-accent": "#1F1608", "--short": "#7EC2BB",
      "--long": "#9DB2E3", "--danger": "#EF8C78", "--success": "#8DC795"
    }
  },
  sepia: {
    name: "Sepia", base: "light", named: true,
    vars: {
      "--bg": "#F4ECDF", "--surface": "#FBF6EE", "--surface-2": "#EDE3D3", "--surface-3": "#E2D6C3",
      "--separator": "#E3D8C6", "--control": "#8E7F69", "--text": "#2B2219", "--text-2": "#5E5141",
      "--text-3": "#716350", "--accent": "#8A4B2A", "--on-accent": "#FFFFFF", "--short": "#3C6B5C",
      "--long": "#4E5C86", "--danger": "#A0362A", "--success": "#47703F"
    }
  },
  slate: {
    name: "Slate", base: "dark", named: true,
    vars: {
      "--bg": "#171B21", "--surface": "#1E232A", "--surface-2": "#272D35", "--surface-3": "#323943",
      "--separator": "#2C323B", "--control": "#76808E", "--text": "#E7EBF0", "--text-2": "#B8C0CB",
      "--text-3": "#97A1AE", "--accent": "#8DB9E0", "--on-accent": "#0F1720", "--short": "#9BCB98",
      "--long": "#C7AED9", "--danger": "#EF8C82", "--success": "#9BCB98"
    }
  },
  night: {
    name: "Night", base: "dark", named: true,
    vars: {
      "--bg": "#101118", "--surface": "#171923", "--surface-2": "#20232F", "--surface-3": "#2B2F3D",
      "--separator": "#262A37", "--control": "#727892", "--text": "#E4E6F2", "--text-2": "#B4B8CF",
      "--text-3": "#9297B2", "--accent": "#E8B86A", "--on-accent": "#1A1408", "--short": "#79CFC3",
      "--long": "#A9B6F5", "--danger": "#F2908A", "--success": "#8FD3A0"
    }
  }
};

const LEGACY_THEMES = { nord: "slate", tokyo: "night", pomofocus: "sepia" };

const THEME_OVERRIDE_KEYS = [
  "--bg", "--surface", "--surface-2", "--surface-3", "--separator", "--control", "--text", "--text-2",
  "--text-3", "--accent", "--on-accent", "--short", "--long", "--danger", "--success"
];

const TOOLBAR_COLORS = {
  focus: "#C0791B",
  short: "#3D9691",
  long:  "#7587C1",
  idle:  "#8C8884",
  ink:   "#1A1714"
};

function migrateSettings(s) {
  if (LEGACY_THEMES[s.theme]) s.theme = LEGACY_THEMES[s.theme];
  if (!THEMES[s.theme]) s.theme = "system";
  if (!ACCENTS[s.accent]) s.accent = "amber";
  if (s.blockMode !== "always") s.blockMode = "duringFocus";
  if (!Array.isArray(s.blocklist)) s.blocklist = DEFAULTS.blocklist.slice();
  return s;
}

async function getSettings() {
  const { settings } = await api.storage.local.get("settings");
  return migrateSettings(Object.assign({}, DEFAULTS, settings || {}));
}

let _settingsWrite = Promise.resolve();
function saveSettings(patch) {
  _settingsWrite = _settingsWrite.catch(() => {}).then(async () => {
    const next = migrateSettings(Object.assign({}, await getSettings(), patch));
    await api.storage.local.set({ settings: next });
    return next;
  });
  return _settingsWrite;
}

async function getSession() {
  const { session } = await api.storage.local.get("session");
  const s = Object.assign({}, IDLE_SESSION, session || {});
  if (session && session.started === undefined) {
    s.started = !!s.running || (s.remaining > 0 && s.remaining < s.duration);
  }
  return s;
}

async function saveSession(session) {
  await api.storage.local.set({ session });
  return session;
}

function remainingSeconds(session) {
  if (session.running && session.endTime) {
    return Math.max(0, (session.endTime - Date.now()) / 1000);
  }
  return session.remaining || 0;
}

function phaseDurationSec(phase, settings) {
  if (phase === "focus") return settings.focusMin * 60;
  if (phase === "long")  return settings.longBreakMin * 60;
  if (phase === "short") return settings.shortBreakMin * 60;
  return 0;
}

function phaseLabel(phase) {
  if (phase === "focus") return "Focus";
  if (phase === "short") return "Short break";
  if (phase === "long")  return "Long break";
  return "Ready";
}

function isBlocking(session, settings) {
  return settings.blockMode === "always" || (session.phase === "focus" && !!session.started);
}

function isFocusLocked(session, settings) {
  return !!settings.strictMode && session.phase === "focus" && !!session.started;
}

function blockedSites(settings) {
  const seen = new Set();
  for (const raw of settings.blocklist || []) {
    const d = normalizeDomain(raw);
    if (d) seen.add(d);
    if (seen.size >= MAX_BLOCKED_SITES) break;
  }
  return Array.from(seen);
}

async function getTasks() {
  const { tasks } = await api.storage.local.get("tasks");
  return Array.isArray(tasks) ? tasks : [];
}

async function saveTasks(tasks) {
  await api.storage.local.set({ tasks });
  return tasks;
}

async function getStats() {
  const { stats } = await api.storage.local.get("stats");
  return stats || {};
}

function splitByDay(seconds, endMs) {
  const parts = [];
  let left = Math.max(0, Math.round(seconds));
  let end = endMs;
  while (left > 0) {
    const last = new Date(end - 1);
    const start = new Date(last.getFullYear(), last.getMonth(), last.getDate()).getTime();
    const take = Math.min(left, Math.ceil((end - start) / 1000));
    parts.push([dateKey(last), take]);
    left -= take;
    end = start;
  }
  return parts;
}

async function recordFocus(seconds, completed, endMs = Date.now()) {
  const stats = await getStats();
  const bump = (key) => (stats[key] = stats[key] || { focusSeconds: 0, sessions: 0 });
  for (const [key, secs] of splitByDay(seconds, endMs)) bump(key).focusSeconds += secs;
  const endKey = dateKey(new Date(endMs - 1));
  if (completed) bump(endKey).sessions += 1;
  await api.storage.local.set({ stats });
  return { stats, endKey };
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

function lastNDays(stats, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dateKey(d);
    const day = stats[key];
    out.push({
      key,
      date: d,
      focusSeconds: day ? day.focusSeconds || 0 : 0,
      sessions: day ? day.sessions || 0 : 0
    });
  }
  return out;
}

function computeStreak(stats, goalSeconds) {
  const met = (key) => {
    const day = stats[key];
    const sec = day ? day.focusSeconds : 0;
    return goalSeconds > 0 ? sec >= goalSeconds : sec > 0;
  };
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (!met(dateKey(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (met(dateKey(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

function fmtClock(totalSec) {
  totalSec = Math.max(0, Math.ceil(totalSec - 0.001));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function durationParts(sec) {
  const total = Math.max(0, Math.floor((Number(sec) || 0) / 60));
  return { h: Math.floor(total / 60), m: total % 60 };
}

function fmtDuration(sec) {
  const { h, m } = durationParts(sec);
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function renderDuration(el, sec) {
  const { h, m } = durationParts(sec);
  el.textContent = "";
  const add = (n, unit) => {
    if (el.childNodes.length) el.append(" ");
    const u = document.createElement("span");
    u.className = "unit";
    u.textContent = unit;
    el.append(String(n), u);
  };
  if (h > 0) add(h, "h");
  if (h === 0 || m > 0) add(m, "m");
  el.setAttribute("aria-label", fmtDuration(sec));
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function weekdayLabels(dates) {
  const count = (s) => {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)).length;
    }
    return Array.from(s).length;
  };
  const make = (weekday) => dates.map((d) => d.toLocaleDateString(undefined, { weekday }));
  const unique = (arr) => new Set(arr).size === arr.length;
  const short = make("short");
  if (unique(short) && short.every((l) => count(l) <= 4)) return short;
  const narrow = make("narrow");
  if (unique(narrow)) return narrow;
  return short;
}

function normalizeDomain(input) {
  if (!input) return "";
  let s = String(input).trim();
  if (!s) return "";
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "http://" + s).hostname;
  } catch (_) {
    return "";
  }
  host = host.toLowerCase().replace(/\.$/, "").replace(/^\*\./, "").replace(/^www\./, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((n) => Number(n) <= 255) ? host : "";
  }
  const labels = host.split(".");
  if (labels.length < 2) return "";
  if (!labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) return "";
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1])) return "";
  return host;
}

function punyAdapt(delta, points, first) {
  let k = 0;
  delta = first ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / points);
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    k += 36;
  }
  return k + Math.floor((36 * delta) / (delta + 38));
}

function punyDecode(label) {
  const input = label.slice(4);
  const out = [];
  const cut = input.lastIndexOf("-");
  if (cut > 0) for (const ch of input.slice(0, cut)) out.push(ch.codePointAt(0));
  let pos = cut > 0 ? cut + 1 : 0;
  let n = 128;
  let i = 0;
  let bias = 72;
  while (pos < input.length) {
    const before = i;
    for (let w = 1, k = 36; ; k += 36) {
      if (pos >= input.length) throw new Error("bad punycode");
      const c = input.charCodeAt(pos++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : c >= 65 && c <= 90 ? c - 65 : 36;
      if (digit >= 36) throw new Error("bad punycode");
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
    }
    bias = punyAdapt(i - before, out.length + 1, before === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

function displayDomain(domain) {
  if (!domain.includes("xn--")) return domain;
  try {
    return domain.split(".").map((l) => (l.startsWith("xn--") ? punyDecode(l) : l)).join(".");
  } catch (_) {
    return domain;
  }
}

function resolveBase(settings) {
  const theme = THEMES[settings.theme] || THEMES.system;
  if (theme.base !== "auto") return theme.base;
  if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

function modeColors(settings) {
  const theme = THEMES[settings.theme] || THEMES.system;
  if (theme.named) {
    return { focus: theme.vars["--accent"], short: theme.vars["--short"], long: theme.vars["--long"] };
  }
  const base = resolveBase(settings);
  const accent = ACCENTS[settings.accent] || ACCENTS.amber;
  const vars = THEMES[base].vars;
  return { focus: accent[base], short: vars["--short"], long: vars["--long"] };
}

function applyAppearance(settings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = THEMES[settings.theme] || THEMES.system;
  const base = resolveBase(settings);
  root.setAttribute("data-theme", base);
  for (const k of THEME_OVERRIDE_KEYS) root.style.removeProperty(k);
  if (theme.named) {
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  } else {
    const accent = ACCENTS[settings.accent] || ACCENTS.amber;
    root.style.setProperty("--accent", accent[base]);
    root.style.setProperty("--on-accent", base === "dark" ? "#1F1608" : "#FFFFFF");
  }
}

function watchAppearance(onChange) {
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
    const settings = await getSettings();
    if ((THEMES[settings.theme] || THEMES.system).base !== "auto") return;
    applyAppearance(settings);
    if (onChange) onChange(settings);
  });
}
