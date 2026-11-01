// The recording pill: a live waveform and a timer while the shortcut is held.

const { listen } = window.__TAURI__.event;

const BAR_COUNT = 16;
const MAX_HEIGHT = 22;
const wave = document.getElementById("wave");
const pill = document.getElementById("pill");
const time = document.getElementById("time");
const message = document.getElementById("message");
const levels = new Array(BAR_COUNT).fill(0);

for (let i = 0; i < BAR_COUNT; i++) {
  wave.appendChild(document.createElement("span"));
}
const bars = [...wave.querySelectorAll("span")];

function draw() {
  bars.forEach((bar, i) => {
    // The bars grow up and down from the middle line. The square root makes
    // quiet speech visible.
    const height = 2 + Math.round(Math.sqrt(levels[i]) * (MAX_HEIGHT - 2));
    bar.style.height = `${height}px`;
  });
}

let startedAt = 0;
let timer = null;
let showingError = false;

function showError(payload) {
  showingError = true;
  clearInterval(timer);
  pill.classList.remove("opening", "busy");
  pill.classList.add("error");
  message.textContent = payload.bubble ?? (payload.code === "microphone"
    ? "Microphone unavailable. Check settings."
    : payload.code === "ffmpeg"
      ? "ffmpeg is missing. Check settings."
      : "Something went wrong. Check settings.");
  message.title = payload.message ?? "";
  message.hidden = false;
}

function showTime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

listen("sidecar", ({ payload }) => {
  if ((payload.ev === "error" && typeof payload.bubble === "string")
      || (payload.ev === "state" && payload.state === "error")) {
    showError(payload);
  } else if (payload.ev === "level" && !showingError) {
    levels.shift();
    levels.push(Math.min(1, payload.level));
    draw();
  } else if (payload.ev === "state") {
    const active = ["opening", "recording", "transcribing"].includes(payload.state);
    // The sidecar returns to idle immediately after reporting an upload
    // failure. Keep the error visible; the shell dismisses it after 6 s.
    if (showingError && !active) return;
    showingError = false;
    pill.classList.remove("error");
    message.hidden = true;
    message.textContent = "";
    pill.classList.toggle("opening", payload.state === "opening");
    pill.classList.toggle("busy", payload.state === "transcribing");
    clearInterval(timer);
    if (payload.state === "opening") {
      // The microphone is not ready yet. The dot turns red when it is.
      levels.fill(0);
      draw();
      time.textContent = "0:00";
    } else if (payload.state === "recording") {
      startedAt = Date.now();
      showTime();
      timer = setInterval(showTime, 250);
    }
  }
});

draw();
