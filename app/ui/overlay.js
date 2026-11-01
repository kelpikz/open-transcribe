// The recording pill: a live waveform and a timer while the shortcut is held.

const { listen } = window.__TAURI__.event;

const BAR_COUNT = 16;
const MAX_HEIGHT = 22;
const wave = document.getElementById("wave");
const pill = document.getElementById("pill");
const time = document.getElementById("time");
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

function showTime() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

listen("sidecar", ({ payload }) => {
  if (payload.ev === "level") {
    levels.shift();
    levels.push(Math.min(1, payload.level));
    draw();
  } else if (payload.ev === "state") {
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
