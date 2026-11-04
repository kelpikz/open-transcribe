// The settings page: how to dictate (or what is wrong), and the settings.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const REPO = "kelpikz/open-transcribe";
const LOGIN_COMMAND = "codex login";
const FFMPEG_COMMAND = "winget install ffmpeg";

const $ = (id) => document.getElementById(id);

/** What the sidecar told us last. */
const app = {
  state: "starting",
  message: "",
  code: null,
  signedIn: true,
  last: null,
  hotkey: "",
  devices: [],
  device: null,
  microphone: null,
};

function command(cmd) {
  return invoke("send", { line: JSON.stringify(cmd) }).catch((error) => toast(String(error), true));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} is copied.`);
  } catch {
    toast(`Could not copy. Type it: ${text}`, true);
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEY_LABELS = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", win: "Win", space: "Space", capslock: "Caps Lock", scrolllock: "Scroll Lock" };

function keyLabel(name) {
  return KEY_LABELS[name] ?? (name.length === 1 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1));
}

function prettyHotkey(spec) {
  return spec.split("+").map(keyLabel).join(" + ");
}

function keysNode(names) {
  const node = el("span", "keys");
  node.append(...names.map((name) => el("kbd", "", name)));
  return node;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function how(main, sub) {
  const node = el("p", "how");
  node.append(...main);
  if (sub) node.append(el("small", "", sub));
  return node;
}

/** A problem: what is wrong, what to do, and buttons. `text` may hold <code> nodes. */
function problem(title, text, actions) {
  const node = el("div");
  const body = el("p", "problem-text");
  body.append(...text);
  const buttons = el("div", "problem-actions");
  actions.forEach(([label, onClick], i) => {
    const button = el("button", i === 0 ? "btn primary" : "btn on-tone", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    buttons.append(button);
  });
  node.append(el("p", "problem-title", title), body);
  if (actions.length > 0) node.append(buttons);
  return node;
}

const code = (text) => el("code", "", text);

function statusContent() {
  const keys = app.hotkey ? keysNode(app.hotkey.split("+").map(keyLabel)) : "the shortcut";
  switch (app.state) {
    case "error":
      if (app.code === "ffmpeg") {
        return problem(
          "ffmpeg is missing",
          ["open-transcribe needs ffmpeg to record. Run ", code(FFMPEG_COMMAND), " in a terminal, then restart the app."],
          [["Copy the command", () => copyText(FFMPEG_COMMAND, "The command")]],
        );
      }
      if (app.code === "microphone") {
        return problem(
          "The microphone is not available",
          [`${app.message} Connect a microphone, or choose a different one below.`],
          [["Try again", () => command({ cmd: "setMicrophone", name: app.microphone })]],
        );
      }
      return problem("Something went wrong", [app.message || "The app stopped."], []);
    case "starting": {
      const node = el("p", "how");
      node.append(el("span", "spinner"), "Starting");
      node.append(el("small", "", "Looking for the microphone."));
      return node;
    }
  }
  if (!app.signedIn) {
    return problem(
      "Signed out",
      ["open-transcribe uses the ChatGPT sign-in of Codex. Run ", code(LOGIN_COMMAND), " in a terminal. Then click Check again."],
      [
        ["Check again", () => command({ cmd: "checkAccount" })],
        ["Copy the command", () => copyText(LOGIN_COMMAND, "The command")],
      ],
    );
  }
  if (app.state === "opening") return how(["Opening the microphone…"], "Speak when the dot in the pill turns red.");
  if (app.state === "recording") return how(["Listening…"], "Release the keys to insert the text.");
  if (app.state === "transcribing") return how(["Converting the speech to text…"], "The text goes where your cursor is.");
  return how(["Hold ", keys, " in any text field and speak."], "Release the keys to insert the text.");
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const DELIVERY_TEXT = { pasted: "was pasted", copied: "was copied to the clipboard", failed: "was not pasted" };

function lastText() {
  if (!app.last) return "";
  const at = new Date(app.last.at);
  const when = at.toDateString() === new Date().toDateString() ? timeFormat.format(at) : `${dayFormat.format(at)}, ${timeFormat.format(at)}`;
  return `Last text at ${when} ${DELIVERY_TEXT[app.last.delivery] ?? ""}`.trim();
}

function renderStatus() {
  document.body.dataset.state = app.state;
  const isProblem = app.state === "error" || (app.state !== "starting" && !app.signedIn);
  $("status").classList.toggle("problem", isProblem);
  $("status-body").replaceChildren(statusContent());
  $("status-foot").hidden = isProblem || app.state === "starting";
  $("last-text").textContent = lastText();
  $("copy-last").hidden = !app.last;
}

$("copy-last").addEventListener("click", async () => {
  await command({ cmd: "copyLast" });
});

// ---------------------------------------------------------------------------
// Microphone list and level meter
// ---------------------------------------------------------------------------

const METER_BARS = 6;
for (let i = 0; i < METER_BARS; i++) $("meter").append(el("span"));

function drawMeter(level) {
  // The square root makes quiet speech visible.
  const lit = Math.round(Math.sqrt(Math.min(1, level)) * METER_BARS);
  $("meter").childNodes.forEach((bar, i) => bar.classList.toggle("on", i < lit));
}

function renderDevices() {
  const select = $("microphone");
  const defaultName = app.devices[0];
  const options = [el("option", "", defaultName ? `Default (${defaultName})` : "Default")];
  options[0].value = "";
  for (const name of app.devices) {
    const option = el("option", "", name);
    option.value = name;
    options.push(option);
  }
  // A chosen device that is not connected stays in the list, so the choice is visible.
  if (app.microphone && !app.devices.includes(app.microphone)) {
    const option = el("option", "", `${app.microphone} (not connected)`);
    option.value = app.microphone;
    options.push(option);
  }
  select.replaceChildren(...options);
  select.value = app.microphone ?? "";
}

// Find a microphone that was connected after the page opened.
$("microphone").addEventListener("mousedown", () => command({ cmd: "listDevices" }));
$("microphone").addEventListener("change", (event) => command({ cmd: "setMicrophone", name: event.target.value || null }));

// ---------------------------------------------------------------------------
// Shortcut
// ---------------------------------------------------------------------------

const MODIFIERS = { Control: "ctrl", Alt: "alt", Shift: "shift", Meta: "win" };
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "win"];
const SPECIAL_CODES = {
  Space: "space",
  Tab: "tab",
  CapsLock: "capslock",
  Insert: "insert",
  Pause: "pause",
  ScrollLock: "scrolllock",
};

/** The name the sidecar uses for a key that is not a modifier, or null. */
function mainKeyName(keyCode) {
  const letter = /^Key([A-Z])$/.exec(keyCode);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(keyCode);
  if (digit) return digit[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(keyCode)) return keyCode.toLowerCase();
  return SPECIAL_CODES[keyCode] ?? null;
}

function renderHotkey() {
  $("hotkey").replaceChildren(...app.hotkey.split("+").map((name) => el("kbd", "", keyLabel(name))));
}

let capturing = false;
let peak = new Set();

function modifiersOf(event) {
  const names = new Set();
  if (event.ctrlKey) names.add("ctrl");
  if (event.altKey) names.add("alt");
  if (event.shiftKey) names.add("shift");
  if (event.metaKey) names.add("win");
  return names;
}

function combo(modifiers, main) {
  const names = MODIFIER_ORDER.filter((name) => modifiers.has(name));
  if (main) names.push(main);
  return names.join("+");
}

function showCapture(modifiers) {
  const names = MODIFIER_ORDER.filter((name) => modifiers.has(name)).map(keyLabel);
  $("hotkey").replaceChildren(...[...names, "…"].map((name) => el("kbd", "", name)));
}

function startCapture() {
  capturing = true;
  peak = new Set();
  $("shortcut-row").classList.add("capturing");
  $("change").textContent = "Cancel";
  showCapture(new Set());
  command({ cmd: "pauseHotkey", paused: true });
}

function endCapture(newHotkey) {
  capturing = false;
  $("shortcut-row").classList.remove("capturing");
  $("change").textContent = "Change";
  command({ cmd: "pauseHotkey", paused: false });
  if (newHotkey) command({ cmd: "setHotkey", hotkey: newHotkey });
  else renderHotkey();
}

window.addEventListener("keydown", (event) => {
  if (!capturing) return;
  event.preventDefault();
  if (event.key === "Escape") {
    endCapture(null);
    return;
  }
  const modifiers = modifiersOf(event);
  if (MODIFIERS[event.key]) modifiers.add(MODIFIERS[event.key]);
  if (modifiers.size >= peak.size) peak = modifiers;

  if (MODIFIERS[event.key]) {
    showCapture(modifiers);
    return;
  }
  const main = mainKeyName(event.code);
  if (!main) {
    toast(`"${event.key}" cannot be part of a shortcut.`, true);
    return;
  }
  endCapture(combo(modifiers, main));
});

// Only modifiers (for example Ctrl + Win): the shortcut is set when the keys go up.
window.addEventListener("keyup", (event) => {
  if (!capturing || !MODIFIERS[event.key]) return;
  event.preventDefault();
  if (peak.size >= 2) {
    endCapture(combo(peak, null));
  } else if (modifiersOf(event).size === 0) {
    toast("Use two modifier keys, or add a normal key.", true);
    peak = new Set();
    showCapture(peak);
  }
});

$("change").addEventListener("click", () => (capturing ? endCapture(null) : startCapture()));
// Never leave the global shortcut paused: stop the capture when the window
// loses focus or is hidden.
window.addEventListener("blur", () => capturing && endCapture(null));
document.addEventListener("visibilitychange", () => document.hidden && capturing && endCapture(null));

// ---------------------------------------------------------------------------
// Other settings
// ---------------------------------------------------------------------------

$("language").addEventListener("change", (event) => command({ cmd: "setLanguage", language: event.target.value }));
$("after-speak").addEventListener("change", (event) => command({ cmd: "setAfterSpeak", value: event.target.value }));
$("sounds").addEventListener("change", (event) => command({ cmd: "setSounds", on: event.target.checked }));

// Start with Windows is kept by Windows itself, not by the sidecar.
invoke("plugin:autostart|is_enabled")
  .then((enabled) => ($("autostart").checked = enabled))
  .catch(() => ($("autostart").disabled = true));
$("autostart").addEventListener("change", async (event) => {
  const on = event.target.checked;
  try {
    await invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
  } catch (error) {
    event.target.checked = !on;
    toast(`Could not change this setting: ${error}`, true);
  }
});

// ---------------------------------------------------------------------------
// Version and links
// ---------------------------------------------------------------------------

/** True if version `a` is newer than version `b` ("1.2.0" > "1.1.9"). */
function isNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function showVersion() {
  const node = $("version");
  let version = "";
  try {
    version = await window.__TAURI__.app.getVersion();
  } catch {
    return;
  }
  node.textContent = `Version ${version}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    // No release yet, or no network: show the version only.
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.tag_name ?? "").replace(/^v/, "");
    if (!/^\d+(\.\d+)*$/.test(latest)) return;
    if (isNewer(latest, version)) {
      const link = el("a", "", `Version ${latest} is available`);
      link.href = release.html_url;
      link.dataset.external = "";
      node.replaceChildren(`Version ${version} · `, link);
    } else {
      node.textContent = `Version ${version} · up to date`;
    }
  } catch {
    // No network. The version alone is enough.
  }
}

// Links open in the default browser, not in this window.
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-external]");
  if (!link) return;
  event.preventDefault();
  invoke("plugin:shell|open", { path: link.href }).catch((error) => toast(String(error), true));
});

// ---------------------------------------------------------------------------
// Events from the sidecar
// ---------------------------------------------------------------------------

listen("sidecar", ({ payload }) => {
  switch (payload.ev) {
    case "state":
      app.state = payload.state;
      app.message = payload.message ?? "";
      app.code = payload.code ?? null;
      renderStatus();
      if (app.state !== "recording") drawMeter(0);
      break;
    case "level":
      // The level comes only while the shortcut is held.
      drawMeter(payload.level);
      break;
    case "settings": {
      const changed = app.hotkey && app.hotkey !== payload.hotkey;
      app.hotkey = payload.hotkey;
      app.microphone = payload.microphone ?? null;
      $("language").value = payload.language;
      $("after-speak").value = payload.afterSpeak;
      $("sounds").checked = payload.sounds;
      if (!capturing) renderHotkey();
      renderDevices();
      renderStatus();
      if (changed) toast(`The shortcut is now ${prettyHotkey(app.hotkey)}.`);
      break;
    }
    case "devices":
      app.devices = payload.names ?? [];
      app.device = payload.current ?? null;
      renderDevices();
      break;
    case "account": {
      const wasSignedOut = !app.signedIn;
      app.signedIn = payload.signedIn;
      renderStatus();
      if (wasSignedOut && app.signedIn) toast("You are signed in.");
      break;
    }
    case "last":
      app.last = payload.at ? { at: payload.at, delivery: payload.delivery } : null;
      renderStatus();
      break;
    case "copied":
      toast("The last text is copied.");
      break;
    case "error":
      toast(payload.message, true);
      break;
  }
});

// The sidecar may have started before this page loaded. Ask for everything.
command({ cmd: "getState" });
renderStatus();
showVersion();
