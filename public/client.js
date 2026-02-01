/* WordConnector client.js (paste-all) - for your server.js
   - Two DIFFERENT BGMs:
       * LOBBY: bright, lively (major chords + bouncy pluck)
       * GAME: tense, intense (minor tension chords + driving bass + snare + alarm lead)
   - Smooth crossfade between tracks when state switches (LOBBY <-> RUNNING)
   - Accurate scheduling (AudioContext time), minimal stutter
*/


// ---- Dueum (두음법칙) helpers for UI hint ----
const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];

function isHangulSyllable(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}
function decomposeSyllable(ch) {
  if (!isHangulSyllable(ch)) return null;
  const code = ch.charCodeAt(0) - 0xac00;
  const cho = Math.floor(code / 588);
  const jung = Math.floor((code % 588) / 28);
  const jong = code % 28;
  return { cho, jung, jong };
}
function composeSyllable(cho, jung, jong) {
  return String.fromCharCode(0xac00 + (cho * 588) + (jung * 28) + jong);
}

// 서버랑 같은 로직: 기본 + (가능하면) 두음 변환 후보
function dueumVariants(syllable) {
  const out = new Set([syllable]);
  const d = decomposeSyllable(syllable);
  if (!d) return [...out];

  const init = CHO[d.cho];
  const vowel = JUNG[d.jung];
  const yVowels = new Set(["ㅣ","ㅑ","ㅕ","ㅛ","ㅠ","ㅖ","ㅒ"]);

  // ㄹ -> ㄴ (항상), ㄹ -> ㅇ (특정 모음)
  if (init === "ㄹ") {
    out.add(composeSyllable(CHO.indexOf("ㄴ"), d.jung, d.jong)); // 름 -> 늠
    if (yVowels.has(vowel)) out.add(composeSyllable(CHO.indexOf("ㅇ"), d.jung, d.jong));
  }

  // ㄴ -> ㅇ (특정 모음)
  if (init === "ㄴ" && yVowels.has(vowel)) {
    out.add(composeSyllable(CHO.indexOf("ㅇ"), d.jung, d.jong));
  }

  return [...out];
}
const socket = io();

/* -----------------------------
   DOM helpers
----------------------------- */
const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* -----------------------------
   Elements (support older HTML)
----------------------------- */
const elRoom = $("room");
const elNick = $("nickname");
const elJoin = $("join");
const elCopyRoom = $("copyRoom");

const elWord = $("word");
const elSend = $("send");
const elStart = $("startRound") || $("newRound");

const elLog = $("log");
const elCurrentWord = $("currentWord");
const elStatusText = $("statusText");
const elMustStart = $("mustStart");
const elTurnBig = $("turnBig") || $("turn");
const elTimeLeft = $("timeLeft");
const elTimerFill = $("timerFill");
const elPlayersText = $("playersText");
const elRoomHint = $("roomHint");
const elScoreboard = $("scoreboard");

let elTarget = $("targetScore");
let elSetTarget = $("setTarget");
let elResetMatch = $("resetMatch");
let elTargetText = $("targetText");
let elTurnOrder = $("turnOrder");

const elModalBackdrop = $("modalBackdrop");
const elModalMsg = $("modalMsg");
const elModalReason = $("modalReason");
const elModalClose = $("modalClose");
const elModalSub = $("modalSub");
const elModalTitle = $("modalTitle");

/* -----------------------------
   Auto-inject UI if missing
----------------------------- */
function injectControlsIfMissing() {
  const anchor =
    elRoomHint ||
    document.querySelector(".card") ||
    document.querySelector("main") ||
    document.body;

  if (!elTarget || !elSetTarget || !elResetMatch || !elTargetText) {
    const wrap = document.createElement("div");
    wrap.style.marginTop = "12px";
    wrap.style.display = "flex";
    wrap.style.flexWrap = "wrap";
    wrap.style.gap = "10px";
    wrap.style.alignItems = "center";

    const badge = document.createElement("div");
    badge.textContent = "Target";
    badge.style.padding = "10px 12px";
    badge.style.borderRadius = "14px";
    badge.style.border = "1px solid rgba(255,255,255,0.16)";
    badge.style.background = "rgba(255,255,255,0.10)";
    badge.style.fontWeight = "900";
    badge.style.color = "rgba(255,255,255,0.8)";

    elTarget = document.createElement("input");
    elTarget.id = "targetScore";
    elTarget.type = "number";
    elTarget.min = "1";
    elTarget.max = "50";
    elTarget.step = "1";
    elTarget.placeholder = "예: 5";
    elTarget.style.flex = "0 0 140px";
    elTarget.style.minWidth = "140px";
    elTarget.style.padding = "14px 14px";
    elTarget.style.borderRadius = "14px";
    elTarget.style.border = "1px solid rgba(255,255,255,0.20)";
    elTarget.style.background = "rgba(6,22,38,0.38)";
    elTarget.style.color = "rgba(255,255,255,0.94)";
    elTarget.style.outline = "none";

    elSetTarget = document.createElement("button");
    elSetTarget.id = "setTarget";
    elSetTarget.type = "button";
    elSetTarget.textContent = "Set";
    elSetTarget.style.padding = "14px 16px";
    elSetTarget.style.borderRadius = "14px";
    elSetTarget.style.border = "1px solid rgba(255,255,255,0.20)";
    elSetTarget.style.background = "rgba(255,255,255,0.10)";
    elSetTarget.style.color = "#fff";
    elSetTarget.style.fontWeight = "900";
    elSetTarget.style.cursor = "pointer";

    elResetMatch = document.createElement("button");
    elResetMatch.id = "resetMatch";
    elResetMatch.type = "button";
    elResetMatch.textContent = "Reset Scores";
    elResetMatch.style.padding = "14px 16px";
    elResetMatch.style.borderRadius = "14px";
    elResetMatch.style.border = "1px solid rgba(255,255,255,0.20)";
    elResetMatch.style.background = "rgba(255,255,255,0.10)";
    elResetMatch.style.color = "#fff";
    elResetMatch.style.fontWeight = "900";
    elResetMatch.style.cursor = "pointer";

    elTargetText = document.createElement("div");
    elTargetText.id = "targetText";
    elTargetText.textContent = "Target: 5";
    elTargetText.style.marginLeft = "auto";
    elTargetText.style.padding = "10px 12px";
    elTargetText.style.borderRadius = "14px";
    elTargetText.style.border = "1px solid rgba(255,255,255,0.16)";
    elTargetText.style.background = "rgba(6,22,38,0.25)";
    elTargetText.style.fontWeight = "900";
    elTargetText.style.color = "rgba(255,255,255,0.82)";

    wrap.append(badge, elTarget, elSetTarget, elResetMatch, elTargetText);

    if (elRoomHint && elRoomHint.parentElement) {
      elRoomHint.parentElement.insertBefore(wrap, elRoomHint.nextSibling);
    } else {
      anchor.insertBefore(wrap, anchor.firstChild);
    }
  }

  if (!elTurnOrder) {
    const panel = document.createElement("div");
    panel.style.marginTop = "14px";
    panel.style.padding = "14px";
    panel.style.borderRadius = "18px";
    panel.style.border = "1px solid rgba(255,255,255,0.16)";
    panel.style.background = "rgba(6,22,38,0.22)";

    const title = document.createElement("div");
    title.textContent = "Turn Order";
    title.style.fontSize = "13px";
    title.style.fontWeight = "900";
    title.style.color = "rgba(255,255,255,0.72)";

    elTurnOrder = document.createElement("div");
    elTurnOrder.id = "turnOrder";
    elTurnOrder.style.marginTop = "10px";
    elTurnOrder.style.display = "flex";
    elTurnOrder.style.gap = "10px";
    elTurnOrder.style.flexWrap = "wrap";

    panel.append(title, elTurnOrder);

    const timerbar = document.querySelector(".timerbar");
    if (timerbar && timerbar.parentElement) {
      timerbar.parentElement.insertBefore(panel, timerbar.nextSibling);
    } else {
      anchor.appendChild(panel);
    }
  }

  if (elModalBackdrop && elModalClose) {
    elModalClose.onclick = () => closeModal();
    elModalBackdrop.onclick = (e) => {
      if (e.target === elModalBackdrop) closeModal();
    };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !elModalBackdrop.classList.contains("hidden")) closeModal();
    });
  }
}
injectControlsIfMissing();

/* -----------------------------
   State
----------------------------- */
let roomCode = "";
let myId = "";
let deadline = 0;
let timeLimitMs = 12000;

let cachedPlayers = [];
let cachedOrder = [];
let gameState = "LOBBY";
let targetScore = 5;

let timerInterval = null;
let tickLastInt = null;

/* -----------------------------
   Logging (newest on top)
----------------------------- */
const LOG_KEEP_MS = 90_000;
const LOG_MAX_LINES = 120;
let logItems = [];

function nowStamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function renderLog() {
  if (!elLog) return;
  const cutoff = Date.now() - LOG_KEEP_MS;
  logItems = logItems.filter(x => x.ts >= cutoff);
  if (logItems.length > LOG_MAX_LINES) logItems = logItems.slice(0, LOG_MAX_LINES);
  elLog.textContent = logItems.map(x => x.text).join("\n") + (logItems.length ? "\n" : "");
  elLog.scrollTop = 0;
}
function log(msg) {
  logItems.unshift({ ts: Date.now(), text: `[${nowStamp()}] ${msg}` });
  renderLog();
}
setInterval(renderLog, 2000);

/* -----------------------------
   UI
----------------------------- */
function setStatus(s) { if (elStatusText) elStatusText.textContent = s; }
function setMustStart(word) {
  if (!elMustStart) return;

  if (!word) {
    elMustStart.textContent = "(없음)";
    return;
  }

  const last = word[word.length - 1];

  // 마지막 음절이 한글이면 두음 후보까지 같이 표시
  if (isHangulSyllable(last)) {
    const vars = dueumVariants(last);
    elMustStart.textContent = vars.join(" / ");
  } else {
    elMustStart.textContent = last;
  }
}function setCurrentWord(word) { if (elCurrentWord) elCurrentWord.textContent = word || "(none)"; setMustStart(word || ""); }
function setPlayersText() { if (elPlayersText) elPlayersText.textContent = `Players: ${cachedPlayers.length}/4`; }
function setTargetText() { if (elTargetText) elTargetText.textContent = `Target: ${targetScore}`; }

function setTurnLabel(turnId) {
  if (!elTurnBig) return;
  if (!turnId || gameState !== "RUNNING") {
    elTurnBig.textContent = "(waiting)";
    return;
  }
  elTurnBig.textContent = (turnId === myId) ? "YOUR TURN" : "OPPONENT TURN";
  if (turnId === myId && elWord && !elWord.disabled) {
    setTimeout(() => { try { elWord.focus({ preventScroll: true }); } catch {} }, 50);
  }
}

function resetTimerUI() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  tickLastInt = null;
  if (elTimeLeft) elTimeLeft.textContent = "-";
  if (elTimerFill) elTimerFill.style.width = "0%";
}

function applyUiState() {
  const canPlay = (gameState === "RUNNING");
  if (elWord) elWord.disabled = !canPlay;
  if (elSend) elSend.disabled = !canPlay;

  if (elStart) elStart.disabled = (!roomCode) || (gameState === "RUNNING") || (cachedPlayers.length < 2);

  if (elSetTarget) elSetTarget.disabled = (!roomCode) || (gameState === "RUNNING");
  if (elTarget) elTarget.disabled = (!roomCode) || (gameState === "RUNNING");
  if (elResetMatch) elResetMatch.disabled = (!roomCode) || (gameState === "RUNNING");

  if (!canPlay) resetTimerUI();
}

function renderScoreboard(players) {
  if (!elScoreboard) return;
  cachedPlayers = players || cachedPlayers;

  const sorted = [...cachedPlayers].sort((a, b) => {
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    return (a.name || "").localeCompare((b.name || ""), "ko");
  });

  elScoreboard.innerHTML = sorted.map(p => {
    const me = (p.id === myId);
    return `
      <div class="score-row${me ? " me" : ""}">
        <div class="who">
          <span class="avatar">${escapeHtml((p.name || "?").slice(0,1))}</span>
          <span class="name">${escapeHtml(p.name || "Player")}</span>
          ${me ? `<span class="tag">YOU</span>` : ``}
        </div>
        <div class="pts">${p.score ?? 0}</div>
      </div>
    `;
  }).join("");
}

function nameById(id) {
  const p = cachedPlayers.find(x => x.id === id);
  return p ? p.name : id?.slice?.(0, 5) || "Player";
}

function renderTurnOrder(turnId) {
  if (!elTurnOrder) return;
  const ids = cachedOrder.length ? cachedOrder : cachedPlayers.map(p => p.id);

  elTurnOrder.innerHTML = ids.map(id => {
    const isMe = id === myId;
    const isActive = (gameState === "RUNNING") && (id === turnId);

    const base = `
      display:flex;align-items:center;gap:8px;
      padding:10px 12px;border-radius:16px;
      border:1px solid rgba(255,255,255,0.16);
      background:rgba(255,255,255,0.08);
      color:rgba(255,255,255,0.86);
      font-weight:900;
    `;
    const meGlow = isMe ? `border-color:rgba(120,220,255,0.55); box-shadow:0 0 0 4px rgba(120,220,255,0.12);` : "";
    const activeGlow = isActive
      ? `border-color:rgba(120,220,255,0.85);
         background:linear-gradient(135deg, rgba(140,240,255,0.24), rgba(80,160,255,0.14));
         box-shadow:0 0 0 6px rgba(120,220,255,0.16), 0 18px 70px rgba(80,160,255,0.20);`
      : "";

    const tagStyle = `
      font-size:12px;padding:4px 8px;border-radius:999px;
      border:1px solid rgba(255,255,255,0.18);
      background:rgba(255,255,255,0.10);
      color:rgba(255,255,255,0.75);
    `;
    const tag = isMe ? `<span style="${tagStyle}">YOU</span>` : `<span style="${tagStyle}">P</span>`;
    const now = isActive ? `<span style="${tagStyle};border-color:rgba(120,220,255,0.65)">NOW</span>` : "";

    return `<div style="${base}${meGlow}${activeGlow}">${tag}${now}<span>${escapeHtml(nameById(id))}</span></div>`;
  }).join("");
}

/* -----------------------------
   Modal
----------------------------- */
function openModal({ title, sub, msg, reason }) {
  if (!elModalBackdrop || !elModalMsg) {
    log(`📢 ${title ? title + " - " : ""}${msg}`);
    if (reason) log(`   ${reason}`);
    return;
  }
  if (elModalTitle) elModalTitle.textContent = title || "Result";
  if (elModalSub) elModalSub.textContent = sub || "";
  elModalMsg.textContent = msg || "";
  if (elModalReason) elModalReason.textContent = reason || "";
  elModalBackdrop.classList.remove("hidden");
  elModalBackdrop.setAttribute("aria-hidden", "false");
  try { elWord?.blur?.(); } catch {}
}
function closeModal() {
  if (!elModalBackdrop) return;
  elModalBackdrop.classList.add("hidden");
  elModalBackdrop.setAttribute("aria-hidden", "true");
}

/* =========================================================
   🔊 AUDIO: Two completely different tracks
   - LOBBY track: bright + bouncy (major)
   - GAME track: tense + urgent (minor + dissonance + snare + alarm lead)
   - Crossfade on mode change
========================================================= */
let audioCtx = null;
let audioUnlocked = false;

let bus = null;          // Gain -> filters -> limiter -> destination
let masterGain = null;   // overall
let hp = null;
let limiter = null;

let trackGain = { lobby: null, game: null }; // per-track gains for crossfade

let schedTimer = null;
let mode = "lobby"; // "lobby" | "game"
let running = false;

// Scheduler state for each track (independent timing)
const TRACK = {
  lobby: { bpm: 132, lookAhead: 0.12, ahead: 0.9, step: 0, nextT: 0 },
  game:  { bpm: 164, lookAhead: 0.10, ahead: 0.9, step: 0, nextT: 0 } // 160대
};

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}

function makeLimiter() {
  const ws = audioCtx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(2.05 * x);
  }
  ws.curve = curve;
  ws.oversample = "4x";
  return ws;
}

function setupAudioChain() {
  if (bus) return;

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.20;

  hp = audioCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 110;

  limiter = makeLimiter();

  bus = audioCtx.createGain();
  bus.gain.value = 1.0;

  // per-track gains feeding into bus
  trackGain.lobby = audioCtx.createGain();
  trackGain.game  = audioCtx.createGain();
  trackGain.lobby.gain.value = 1.0;
  trackGain.game.gain.value  = 0.0001;

  trackGain.lobby.connect(bus);
  trackGain.game.connect(bus);

  bus.connect(masterGain);
  masterGain.connect(hp);
  hp.connect(limiter);
  limiter.connect(audioCtx.destination);
}

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    ensureAudio();
    setupAudioChain();
    audioUnlocked = true;
    startMusic();
    log("🔊 오디오 ON (BGM 시작)");
  } catch {}
}

function startMusic() {
  if (!audioUnlocked || running) return;
  running = true;

  // init both tracks times (so switch is instant)
  const t0 = audioCtx.currentTime + 0.08;
  TRACK.lobby.step = 0; TRACK.lobby.nextT = t0;
  TRACK.game.step  = 0; TRACK.game.nextT  = t0;

  if (schedTimer) clearInterval(schedTimer);
  // scheduler ticks at fastest lookAhead (game)
  schedTimer = setInterval(() => {
    scheduleLobby();
    scheduleGame();
  }, 60);
}

function stopMusic() {
  running = false;
  if (schedTimer) clearInterval(schedTimer);
  schedTimer = null;
}

function setMode(nextMode) {
  nextMode = (nextMode === "game") ? "game" : "lobby";
  if (mode === nextMode) return;
  mode = nextMode;

  if (!audioUnlocked) return;

  // crossfade between track gains (feels like different song)
  const now = audioCtx.currentTime;
  const fade = 0.22;

  const from = (mode === "game") ? "lobby" : "game";
  const to   = mode;

  try {
    trackGain[from].gain.cancelScheduledValues(now);
    trackGain[to].gain.cancelScheduledValues(now);

    trackGain[from].gain.setValueAtTime(trackGain[from].gain.value, now);
    trackGain[to].gain.setValueAtTime(trackGain[to].gain.value, now);

    trackGain[from].gain.linearRampToValueAtTime(0.0001, now + fade);
    trackGain[to].gain.linearRampToValueAtTime(1.0, now + fade);
  } catch {}

  log(`🎵 BGM switched: ${mode.toUpperCase()}`);
}

function hzFromMidi(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/* ===== Instruments (shared building blocks) ===== */
function toneOsc(type, t, freq, dur, gain, outNode, filterSpec) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  let f = null;

  o.type = type;
  o.frequency.setValueAtTime(freq, t);

  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  if (filterSpec) {
    f = audioCtx.createBiquadFilter();
    f.type = filterSpec.type;
    f.frequency.setValueAtTime(filterSpec.freq, t);
    if (filterSpec.q != null) f.Q.setValueAtTime(filterSpec.q, t);
    o.connect(f);
    f.connect(g);
  } else {
    o.connect(g);
  }

  g.connect(outNode);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function playKick(t, out, intensity = 1.0) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();

  o.type = "sine";
  o.frequency.setValueAtTime(190, t);
  o.frequency.exponentialRampToValueAtTime(58, t + 0.09);

  const peak = 0.42 * intensity;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + 0.14);
}

function playHat(t, out, intensity = 1.0) {
  // bright hat: very short, highpassed
  const o = audioCtx.createOscillator();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();

  o.type = "triangle";
  o.frequency.setValueAtTime(12000, t);

  f.type = "highpass";
  f.frequency.setValueAtTime(9000, t);

  const peak = 0.055 * intensity;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

  o.connect(f);
  f.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + 0.05);
}

function playSnare(t, out, intensity = 1.0) {
  // snare-ish: square burst + bandpass
  const o = audioCtx.createOscillator();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();

  o.type = "square";
  o.frequency.setValueAtTime(220, t);

  f.type = "bandpass";
  f.frequency.setValueAtTime(1800, t);
  f.Q.setValueAtTime(1.2, t);

  const peak = 0.18 * intensity;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);

  o.connect(f);
  f.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + 0.12);
}

function playPluck(t, midi, out, intensity = 1.0) {
  // bouncy bright pluck
  const freq = hzFromMidi(midi);
  toneOsc("sawtooth", t, freq, 0.18, 0.12 * intensity, out, { type: "lowpass", freq: 5200, q: 0.7 });
}

function playChord(t, midis, out, intensity = 1.0) {
  // airy chord stack
  const g = audioCtx.createGain();
  const f = audioCtx.createBiquadFilter();

  f.type = "highpass";
  f.frequency.setValueAtTime(240, t);

  const peak = 0.060 * intensity;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);

  g.connect(out);

  midis.forEach((m, i) => {
    const o = audioCtx.createOscillator();
    o.type = "sine";
    o.detune.setValueAtTime((i - 1) * 5, t);
    o.frequency.setValueAtTime(hzFromMidi(m), t);
    o.connect(f);
    f.connect(g);
    o.start(t);
    o.stop(t + 0.6);
  });
}

function playBass(t, midi, out, intensity = 1.0) {
  // clean bass: saw + lowpass (less muddy)
  const freq = hzFromMidi(midi);
  const o = audioCtx.createOscillator();
  const f = audioCtx.createBiquadFilter();
  const g = audioCtx.createGain();

  o.type = "sawtooth";
  o.frequency.setValueAtTime(freq, t);

  f.type = "lowpass";
  f.frequency.setValueAtTime(520, t);

  const peak = 0.14 * intensity;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

  o.connect(f);
  f.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + 0.16);
}

function playAlarmLead(t, out, intensity = 1.0) {
  // “긴장감” 리드: 약간 불협(트라이톤 느낌)
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.08 * intensity, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
  g.connect(out);

  const o1 = audioCtx.createOscillator();
  const o2 = audioCtx.createOscillator();
  o1.type = "square";
  o2.type = "square";

  o1.frequency.setValueAtTime(880, t);  // A5
  o2.frequency.setValueAtTime(1244, t); // ~D#6 (불협 느낌)

  o1.connect(g);
  o2.connect(g);

  o1.start(t);
  o2.start(t);
  o1.stop(t + 0.12);
  o2.stop(t + 0.12);
}

/* ===== Track scheduling ===== */
function scheduleLobby() {
  if (!running) return;
  const st = TRACK.lobby;
  const spb = 60 / st.bpm;
  const stepDur = spb / 4;

  while (st.nextT < audioCtx.currentTime + st.ahead) {
    const step = st.step % 16;
    const bar = Math.floor(st.step / 16);

    // LOBBY: uplifting C major progression: C -> G -> Am -> F
    const chords = [
      [60, 64, 67], // C
      [67, 71, 74], // G
      [69, 72, 76], // Am
      [65, 69, 72]  // F
    ];
    const chord = chords[bar % 4];

    // groove
    const kick = (step === 0 || step === 8 || step === 12);
    const hat  = (step % 2 === 0) || (step === 14);
    const playCh = (step === 0 || step === 8);

    // cute melody
    const mel = [72, 74, 76, 79, 76, 74, 72, 71];
    const playMel = (step === 1 || step === 5 || step === 9 || step === 13);

    const t = st.nextT;
    const out = trackGain.lobby;

    if (kick) playKick(t, out, 0.95);
    if (hat)  playHat(t, out, 0.90);
    if (playCh) playChord(t, chord, out, 0.95);

    if (playMel) {
      const note = mel[(bar + (step >> 2)) % mel.length];
      playPluck(t, note, out, 1.0);
    }

    st.nextT += stepDur;
    st.step++;
  }
}

function scheduleGame() {
  if (!running) return;
  const st = TRACK.game;
  const spb = 60 / st.bpm;
  const stepDur = spb / 4;

  while (st.nextT < audioCtx.currentTime + st.ahead) {
    const step = st.step % 16;
    const bar = Math.floor(st.step / 16);

    // GAME: tense progression in A minor-ish with tension colors:
    // Am(add b2 느낌) -> G -> F -> E (긴장 종지)
    // chord tones as MIDI (keep it darker)
    const chords = [
      [57, 60, 64], // A minor (A C E)
      [55, 59, 62], // G (G B D)
      [53, 57, 60], // F (F A C)
      [52, 55, 59]  // E (E G B) (minor-ish)
    ];
    const chord = chords[bar % 4];

    // aggressive rhythm
    const kick = (step === 0 || step === 4 || step === 8 || step === 12); // four-on-the-floor
    const snare = (step === 4 || step === 12); // backbeat
    const hat = (step % 2 === 0) || (step === 6) || (step === 10) || (step === 14); // denser
    const playCh = (step === 0 || step === 8);

    // driving bass (A minor scale-ish)
    const bassLine = [45, 45, 48, 45, 50, 45, 52, 45, 45, 45, 43, 45, 52, 45, 50, 45]; // A2.. etc
    const bass = (step % 2 === 0);

    // alarm lead stabs occasionally
    // const alarm = (step === 7 || step === 15);

    const t = st.nextT;
    const out = trackGain.game;

    if (kick) playKick(t, out, 1.05);
    if (snare) playSnare(t, out, 1.0);
    if (hat) playHat(t, out, 1.15);
    if (playCh) playChord(t, chord, out, 1.05);

    if (bass) playBass(t, bassLine[step], out, 1.15);
    // if (alarm) playAlarmLead(t, out, 1.0);

    st.nextT += stepDur;
    st.step++;
  }
}

/* ===== SFX ===== */
function playChime() {
  if (!audioUnlocked) return;
  ensureAudio(); setupAudioChain();
  const now = audioCtx.currentTime;

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

  const o1 = audioCtx.createOscillator();
  const o2 = audioCtx.createOscillator();
  o1.type = "sine";
  o2.type = "triangle";
  o1.frequency.setValueAtTime(1046.5, now); // C6
  o2.frequency.setValueAtTime(1568.0, now); // G6

  o1.connect(g); o2.connect(g);
  g.connect(bus);

  o1.start(now); o2.start(now);
  o1.stop(now + 0.26); o2.stop(now + 0.26);
}

function playTick() {
  if (!audioUnlocked) return;
  ensureAudio(); setupAudioChain();
  const now = audioCtx.currentTime;

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.07, now + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  const o = audioCtx.createOscillator();
  o.type = "square";
  o.frequency.setValueAtTime(1850, now);

  o.connect(g);
  g.connect(bus);

  o.start(now);
  o.stop(now + 0.07);
}

/* -----------------------------
   Friendly messages
----------------------------- */
function humanRejectMessage(r) {
  switch (r?.reason) {
    case "round_not_running": return "라운드가 아직 시작되지 않았어. Start Round를 눌러줘!";
    case "not_your_turn": return "지금은 네 차례가 아니야.";
    case "too_late": return "시간이 이미 끝났어!";
    case "not_hangul": return "한글 단어만 입력해줘.";
    case "wrong_start": {
      const list = Array.isArray(r.mustStartList) ? r.mustStartList.join(" / ") : null;
      return list ? `시작 글자가 달라! 가능한 시작: ${list}` : "시작 글자가 달라!";
    }
    case "already_used": return "이미 나온 단어야. 다른 단어로!";
    case "not_in_dictionary": return "사전에 없는 단어로 판단됐어. 다른 표준어로 해봐.";
    default: return "입력이 처리되지 않았어. 다시 시도해줘.";
  }
}
function humanJoinErrorMessage(code) {
  switch (code) {
    case "empty_room_code": return "Room code가 비어 있어.";
    case "room_full": return "방이 꽉 찼어 (최대 4명).";
    default: return "Join에 실패했어. Room code를 확인해줘.";
  }
}
function humanStartError(code) {
  switch (code) {
    case "need_2_players": return "라운드를 시작하려면 최소 2명이 필요해.";
    case "already_running": return "이미 라운드가 진행 중이야.";
    default: return "라운드 시작에 실패했어.";
  }
}

/* -----------------------------
   Actions
----------------------------- */
on(elJoin, "click", () => {
  unlockAudio();
  setMode("lobby");

  const code = (elRoom?.value || "").trim();
  const nickname = (elNick?.value || "").trim();
  if (!code) return log("❌ Room code를 입력해줘.");

  socket.emit("join", { roomCode: code, nickname }, (res) => {
    if (!res?.ok) return log(`❌ ${humanJoinErrorMessage(res?.error)}`);
    roomCode = res.roomCode;
    log(`✅ Room '${roomCode}'에 들어왔어.`);
    if (elRoomHint) elRoomHint.textContent = `Joined: ${roomCode} — Target 설정 후 Start Round`;
    applyUiState();
  });
});

on(elRoom, "keydown", (e) => { if (e.key === "Enter") elJoin?.click(); });
on(elNick, "keydown", (e) => { if (e.key === "Enter") elJoin?.click(); });

on(elCopyRoom, "click", async () => {
  unlockAudio();
  const v = (elRoom?.value || "").trim();
  if (!v) return;
  try { await navigator.clipboard.writeText(v); log(`✅ Room code 복사: ${v}`); }
  catch { log("❌ 복사 실패"); }
});

on(elSetTarget, "click", () => {
  unlockAudio();
  setMode("lobby");
  if (!roomCode) return;

  const n = Number(elTarget?.value || "");
  socket.emit("set_target", { roomCode, targetScore: n }, (res) => {
    if (!res?.ok) return log("❌ Target 설정 실패 (라운드 중이면 변경 불가)");
    if (res.targetScore != null) targetScore = res.targetScore;
    setTargetText();
    log(`🎯 Target score set: ${targetScore}`);
  });
});

on(elResetMatch, "click", () => {
  unlockAudio();
  setMode("lobby");
  if (!roomCode) return;

  socket.emit("reset_match", { roomCode }, (res) => {
    if (!res?.ok) return log("❌ Reset 실패 (라운드 중이면 불가)");
    log("🧼 Scores reset!");
  });
});

on(elStart, "click", () => {
  unlockAudio();
  // anticipate game mode; server state will confirm too
  setMode("game");

  if (!roomCode) return;
  socket.emit("start_round", { roomCode }, (res) => {
    if (!res?.ok) {
      setMode("lobby");
      return log(`❌ ${humanStartError(res?.error)}`);
    }
    log("▶️ 라운드 시작!");
  });
});

on(elSend, "click", () => {
  unlockAudio();
  const w = (elWord?.value || "").trim();
  if (!roomCode) return log("❌ 먼저 Join 해줘.");
  if (gameState !== "RUNNING") return log("❌ 라운드가 아직 시작되지 않았어. Start Round!");
  if (!w) return;

  socket.emit("play", { roomCode, word: w });
  if (elWord) { elWord.value = ""; try { elWord.focus({ preventScroll: true }); } catch {} }
});
on(elWord, "keydown", (e) => { if (e.key === "Enter") elSend?.click(); });

/* -----------------------------
   Socket incoming
----------------------------- */
socket.on("connect", () => {
  myId = socket.id;
  setStatus("Connected");
  log("✅ 서버에 연결됐어.");
  applyUiState();
});

socket.on("disconnect", () => {
  setStatus("Disconnected");
  log("❌ 연결이 끊겼어.");
  gameState = "LOBBY";
  setMode("lobby");
  applyUiState();
});

socket.on("system", ({ message }) => { if (message) log(`• ${message}`); });

socket.on("state", (p) => {
  const { players, currentWord, turn, state, timeLimitMs: tl, order, targetScore: ts } = p || {};

  cachedPlayers = players || cachedPlayers;
  cachedOrder = order || cachedOrder;

  gameState = state || gameState;
  timeLimitMs = tl || timeLimitMs;
  if (ts != null) targetScore = ts;

  setPlayersText();
  setTargetText();
  setCurrentWord(currentWord || "");

  setTurnLabel((gameState === "RUNNING") ? turn : null);
  renderScoreboard(cachedPlayers);
  renderTurnOrder((gameState === "RUNNING") ? turn : null);
  applyUiState();

  // ✅ music mode driven by server state
  if (audioUnlocked) {
    setMode(gameState === "RUNNING" ? "game" : "lobby");
  } else {
    mode = (gameState === "RUNNING") ? "game" : "lobby";
  }
});

socket.on("timer_stop", () => resetTimerUI());

socket.on("timer", ({ deadline: dl, turn, timeLimitMs: tl }) => {
  if (gameState !== "RUNNING") return;

  deadline = dl;
  timeLimitMs = tl || timeLimitMs;
  tickLastInt = null;

  setTurnLabel(turn);
  renderTurnOrder(turn);

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const leftMs = Math.max(0, deadline - Date.now());
    if (elTimeLeft) elTimeLeft.textContent = (leftMs / 1000).toFixed(1) + "s";
    const pct = timeLimitMs ? (leftMs / timeLimitMs) * 100 : 0;
    if (elTimerFill) elTimerFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;

    const leftSec = Math.ceil(leftMs / 1000);
    if (leftSec <= 3 && leftSec >= 1) {
      if (tickLastInt !== leftSec) {
        tickLastInt = leftSec;
        playTick();
      }
    }

    if (leftMs <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      tickLastInt = null;
    }
  }, 80);
});

socket.on("word_played", ({ by, byId, word }) => {
  const who = (byId === myId) ? "YOU" : (by || "Player");
  log(`🧩 ${who}: ${word}`);
});

socket.on("accept", () => playChime());
socket.on("reject", (r) => log(`❌ ${humanRejectMessage(r)}`));

socket.on("round_end", ({ reason, winner, loser, scores, targetScore: ts }) => {
  gameState = "LOBBY";
  setMode("lobby");
  applyUiState();
  resetTimerUI();

  if (Array.isArray(scores)) {
    cachedPlayers = scores;
    renderScoreboard(scores);
  }
  if (ts != null) targetScore = ts;
  setTargetText();

  const winnerName = (cachedPlayers.find(p => p.id === winner)?.name) || (winner === myId ? "YOU" : "상대");
  const loserName  = (cachedPlayers.find(p => p.id === loser )?.name) || (loser  === myId ? "YOU" : "상대");

  const msg = `${loserName} 님이 ${winnerName} 님에게 졌습니다. (+1점)`;
  const reasonText = (reason === "timeout") ? "사유: 시간 초과" : "사유: 라운드 종료";

  log(`🏁 ${msg} (${reasonText.replace("사유: ", "")})`);

  openModal({
    title: "Round Over",
    sub: `Target: ${targetScore}`,
    msg,
    reason: reasonText
  });

  setTurnLabel(null);
  renderTurnOrder(null);
});

socket.on("match_end", ({ winner, scores, targetScore: ts }) => {
  gameState = "LOBBY";
  setMode("lobby");
  applyUiState();
  resetTimerUI();

  if (Array.isArray(scores)) {
    cachedPlayers = scores;
    renderScoreboard(scores);
  }
  if (ts != null) targetScore = ts;
  setTargetText();

  const winnerName = (cachedPlayers.find(p => p.id === winner)?.name) || (winner === myId ? "YOU" : "상대");
  log(`🏆 MATCH WINNER: ${winnerName} (Target ${targetScore})`);

  openModal({
    title: "Match Winner!",
    sub: `Reached ${targetScore} points`,
    msg: `🏆 ${winnerName} 님이 먼저 ${targetScore}점에 도달했습니다!`,
    reason: "Reset Scores로 새 매치를 시작할 수 있어."
  });
});

/* -----------------------------
   Init
----------------------------- */
(function init() {
  if (elLog && !elLog.textContent.trim()) log("• Ready. Join → Set Target → Start Round");
  setTargetText();
  applyUiState();
})();