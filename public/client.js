const socket = io();

const elRoom = document.getElementById("room");
const elNick = document.getElementById("nickname");
const elJoin = document.getElementById("join");
const elCopyRoom = document.getElementById("copyRoom");

const elWord = document.getElementById("word");
const elSend = document.getElementById("send");
const elStart = document.getElementById("newRound"); // Start Round 버튼

const elLog = document.getElementById("log");
const elCurrentWord = document.getElementById("currentWord");
const elTurn = document.getElementById("turn");
const elTimeLeft = document.getElementById("timeLeft");
const elTimerFill = document.getElementById("timerFill");
const elStatusText = document.getElementById("statusText");

const elPlayersText = document.getElementById("playersText");
const elMustStart = document.getElementById("mustStart");
const elRoomHint = document.getElementById("roomHint");
const elScoreboard = document.getElementById("scoreboard");

/* ✅ modal elements */
const elModalBackdrop = document.getElementById("modalBackdrop");
const elModalMsg = document.getElementById("modalMsg");
const elModalReason = document.getElementById("modalReason");
const elModalClose = document.getElementById("modalClose");
const elModalSub = document.getElementById("modalSub");

let roomCode = "";
let myId = "";
let deadline = 0;
let timeLimitMs = 0;
let timerInterval = null;

let cachedPlayers = [];
let gameState = "LOBBY"; // LOBBY | RUNNING

/* ---------------------------
   Log prune (최근만 남기기) + 최신이 위
--------------------------- */
const LOG_KEEP_MS = 90_000;  // 90초
const LOG_MAX_LINES = 80;    // 최대 80줄
let logItems = []; // {ts, text}  // 0번이 최신

function t() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderLog() {
  const cutoff = Date.now() - LOG_KEEP_MS;
  logItems = logItems.filter(x => x.ts >= cutoff);

  if (logItems.length > LOG_MAX_LINES) {
    logItems = logItems.slice(0, LOG_MAX_LINES); // 오래된 건 뒤에 있으니 뒤가 잘려나감
  }

  elLog.textContent = logItems.map(x => x.text).join("\n") + (logItems.length ? "\n" : "");
  elLog.scrollTop = 0; // 최신이 위
}

function log(msg) {
  logItems.unshift({ ts: Date.now(), text: `[${t()}] ${msg}` });
  renderLog();
}
setInterval(renderLog, 2000);

/* ---------------------------
   UI helpers
--------------------------- */
function setStatus(text) {
  elStatusText.textContent = text;
}
function lastChar(word) {
  return word ? word[word.length - 1] : "";
}
function setMustStart(currentWord) {
  elMustStart.textContent = currentWord ? lastChar(currentWord) : "(없음)";
}
function setTurn(turnId) {
  elTurn.textContent = turnId ? (turnId === myId ? "YOU" : "OPPONENT") : "(waiting)";
}
function resetTimerUI() {
  if (timerInterval) clearInterval(timerInterval);
  elTimeLeft.textContent = "-";
  elTimerFill.style.width = "0%";
}
function applyUiState() {
  const canPlay = (gameState === "RUNNING");

  elWord.disabled = !canPlay;
  elSend.disabled = !canPlay;

  elStart.disabled = (gameState === "RUNNING") || !roomCode;
  elStart.textContent = (gameState === "RUNNING") ? "Running..." : "Start Round";

  if (!canPlay) resetTimerUI();
}

/* ---------------------------
   Modal helpers
--------------------------- */
function openModal(message, reasonText = "") {
  elModalMsg.textContent = message;
  elModalReason.textContent = reasonText || "";
  elModalSub.textContent = "라운드 결과";
  elModalBackdrop.classList.remove("hidden");
  elModalBackdrop.setAttribute("aria-hidden", "false");

  // 모달 뜨는 동안 키 입력 실수 방지
  elWord.blur();
}

function closeModal() {
  elModalBackdrop.classList.add("hidden");
  elModalBackdrop.setAttribute("aria-hidden", "true");
}

elModalClose.addEventListener("click", closeModal);
elModalBackdrop.addEventListener("click", (e) => {
  // backdrop 바깥 클릭 시 닫기 (modal 클릭은 무시)
  if (e.target === elModalBackdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !elModalBackdrop.classList.contains("hidden")) closeModal();
});

/* ---------------------------
   Friendly messages (에러코드 숨김)
--------------------------- */
function humanRejectMessage(r) {
  switch (r?.reason) {
    case "round_not_running":
      return "라운드가 아직 시작되지 않았어. Start Round를 눌러줘!";
    case "not_your_turn":
      return "지금은 네 차례가 아니야.";
    case "too_late":
      return "시간이 이미 끝났어!";
    case "not_hangul":
      return "한글 단어만 입력해줘.";
    case "wrong_start": {
      const list = Array.isArray(r.mustStartList) ? r.mustStartList.join(" / ") : null;
      return list ? `시작 글자가 달라! 가능한 시작: ${list}` : "시작 글자가 달라!";
    }
    case "already_used":
      return "이미 나온 단어야. 다른 단어로!";
    case "not_in_dictionary":
      return "사전에 없는 단어로 판단됐어. 다른 표준어로 해봐.";
    case "waiting_for_opponent":
      return "최소 2명이 필요해.";
    case "not_in_room":
      return "먼저 같은 Room에 Join 해야 해.";
    default:
      return "입력이 처리되지 않았어. 다시 시도해줘.";
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

/* ---------------------------
   Scoreboard
--------------------------- */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function renderScoreboard(players) {
  cachedPlayers = players || cachedPlayers;

  const sorted = [...cachedPlayers].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name, "ko");
  });

  elScoreboard.innerHTML = sorted.map(p => {
    const me = p.id === myId ? " me" : "";
    return `
      <div class="score-row${me}">
        <div class="who">
          <span class="avatar">${(p.name || "?").slice(0,1)}</span>
          <span class="name">${escapeHtml(p.name || "Player")}</span>
          ${p.id === myId ? `<span class="tag">YOU</span>` : ``}
        </div>
        <div class="pts">${p.score}</div>
      </div>
    `;
  }).join("");
}

/* ---------------------------
   Socket hooks
--------------------------- */
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
  applyUiState();
});

/* Join */
elJoin.addEventListener("click", () => {
  const code = (elRoom.value || "").trim();
  const nickname = (elNick.value || "").trim();

  if (!code) {
    log("❌ Room code를 입력해줘.");
    return;
  }

  socket.emit("join", { roomCode: code, nickname }, (res) => {
    if (!res?.ok) {
      log(`❌ ${humanJoinErrorMessage(res?.error)}`);
      return;
    }

    roomCode = res.roomCode;
    log(`✅ Room '${roomCode}'에 들어왔어. Start Round로 시작!`);
    if (elRoomHint) elRoomHint.textContent = `Joined: ${roomCode} — Start Round를 눌러 게임 시작`;
    applyUiState();
  });
});

elRoom.addEventListener("keydown", (e) => { if (e.key === "Enter") elJoin.click(); });
elNick.addEventListener("keydown", (e) => { if (e.key === "Enter") elJoin.click(); });

/* Copy */
elCopyRoom.addEventListener("click", async () => {
  const v = (elRoom.value || "").trim();
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    log(`✅ Room code 복사 완료: ${v}`);
  } catch {
    log("❌ 복사 실패 (브라우저 권한 문제).");
  }
});

/* Start Round */
elStart.addEventListener("click", () => {
  if (!roomCode) return;
  socket.emit("start_round", { roomCode }, (res) => {
    if (!res?.ok) {
      log(`❌ ${humanStartError(res?.error)}`);
      return;
    }
    log("▶️ 라운드 시작!");
  });
});

/* Send word */
elSend.addEventListener("click", () => {
  const w = (elWord.value || "").trim();
  if (!roomCode) {
    log("❌ 먼저 Room에 Join 해줘.");
    return;
  }
  if (gameState !== "RUNNING") {
    log("❌ 라운드가 아직 시작되지 않았어. Start Round를 눌러줘!");
    return;
  }
  if (!w) return;

  socket.emit("play", { roomCode, word: w });
  elWord.value = "";
  elWord.focus();
});
elWord.addEventListener("keydown", (e) => { if (e.key === "Enter") elSend.click(); });

/* Server events */
socket.on("system", ({ message }) => { if (message) log(`• ${message}`); });

socket.on("state", ({ players, currentWord, turn, state, timeLimitMs: tl }) => {
  timeLimitMs = tl || timeLimitMs;
  gameState = state || "LOBBY";

  elPlayersText.textContent = `Players: ${players.length}/4`;
  elCurrentWord.textContent = currentWord || "(none)";
  setMustStart(currentWord);

  setTurn(gameState === "RUNNING" ? turn : null);
  renderScoreboard(players);
  applyUiState();
});

socket.on("timer_stop", () => resetTimerUI());

socket.on("timer", ({ deadline: dl, turn, timeLimitMs: tl }) => {
  if (gameState !== "RUNNING") return;

  deadline = dl;
  timeLimitMs = tl;
  setTurn(turn);

  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const leftMs = Math.max(0, deadline - Date.now());
    elTimeLeft.textContent = (leftMs / 1000).toFixed(1) + "s";

    const pct = timeLimitMs ? (leftMs / timeLimitMs) * 100 : 0;
    elTimerFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;

    if (leftMs <= 0) clearInterval(timerInterval);
  }, 80);
});

/* everyone sees who played what */
socket.on("word_played", ({ by, byId, word }) => {
  const who = (byId === myId) ? "YOU" : by;
  log(`🧩 ${who}: ${word}`);
});

socket.on("reject", (r) => log(`❌ ${humanRejectMessage(r)}`));

/* ✅ round end popup */
socket.on("round_end", ({ reason, winner, loser, scores }) => {
  // 라운드 끝 → 입력/타이머 정지
  gameState = "LOBBY";
  applyUiState();
  resetTimerUI();
  setTurn(null);

  const winnerName = cachedPlayers.find(p => p.id === winner)?.name || (winner === myId ? "YOU" : "상대");
  const loserName  = cachedPlayers.find(p => p.id === loser )?.name || (loser  === myId ? "YOU" : "상대");

  const msg = `${loserName} 님이 ${winnerName} 님에게 졌습니다. (+1점)`;

  let reasonText = "";
  if (reason === "timeout") reasonText = "사유: 시간 초과";
  else reasonText = "사유: 라운드 종료";

  // 로그에도 남기고
  log(`🏁 ${msg} (${reasonText.replace("사유: ", "")})`);

  // ✅ 팝업 띄우기
  openModal(msg, reasonText);

  if (scores) renderScoreboard(scores);
});

socket.on("player_left", () => {
  log("• 누군가 나갔어. 라운드는 대기 상태로 돌아가.");
  gameState = "LOBBY";
  applyUiState();
});