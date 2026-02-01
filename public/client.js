const socket = io();

const elRoom = document.getElementById("room");
const elJoin = document.getElementById("join");
const elCopyRoom = document.getElementById("copyRoom");

const elWord = document.getElementById("word");
const elSend = document.getElementById("send");

const elLog = document.getElementById("log");
const elCurrentWord = document.getElementById("currentWord");
const elTurn = document.getElementById("turn");
const elTimeLeft = document.getElementById("timeLeft");
const elTimerFill = document.getElementById("timerFill");
const elStatusText = document.getElementById("statusText");

const elPlayersText = document.getElementById("playersText");
const elMustStart = document.getElementById("mustStart");
const elRoomHint = document.getElementById("roomHint");

let roomCode = "";
let myId = "";
let deadline = 0;
let timeLimitMs = 0;
let timerInterval = null;

function t() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function log(msg) {
  elLog.textContent += `[${t()}] ${msg}\n`;
  elLog.scrollTop = elLog.scrollHeight;
}

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

/* ✅ 에러코드 -> 사용자 친화 메시지 매핑 */
function humanRejectMessage(r) {
  switch (r?.reason) {
    case "not_your_turn":
      return "지금은 네 차례가 아니야.";
    case "too_late":
      return "시간 초과! 다음 라운드를 시작해봐.";
    case "not_hangul":
      return "한글 단어만 입력해줘.";
    case "wrong_start":
      return `시작 글자가 달라! '${r.mustStart}'로 시작해야 해.`;
    case "already_used":
      return "이미 사용된 단어야. 다른 단어로!";
    case "not_in_dictionary":
      return "사전에 없는 단어로 판단됐어. 다른 표준어로 해봐.";
    case "waiting_for_opponent":
      return "상대가 아직 입장하지 않았어. 잠깐만!";
    case "not_in_room":
      return "먼저 같은 Room에 Join 해야 해.";
    default:
      return "입력이 처리되지 않았어. 다시 시도해줘.";
  }
}

/* ✅ Join 에러도 코드 숨기고 사람말로 */
function humanJoinErrorMessage(code) {
  switch (code) {
    case "empty_room_code":
      return "Room code가 비어 있어.";
    case "room_full":
      return "방이 꽉 찼어 (2명까지). 다른 Room code를 써줘.";
    case "server_error":
      return "서버 에러가 발생했어. 서버를 재시작해봐.";
    default:
      return "Join에 실패했어. Room code를 다시 확인해줘.";
  }
}

socket.on("connect", () => {
  myId = socket.id;
  setStatus("Connected");
  log("✅ 서버에 연결됐어.");
});

socket.on("disconnect", () => {
  setStatus("Disconnected");
  log("❌ 연결이 끊겼어. 새로고침하거나 서버 상태를 확인해줘.");
  resetTimerUI();
});

/* Join */
elJoin.addEventListener("click", () => {
  const code = (elRoom.value || "").trim();
  if (!code) {
    log("❌ Room code를 입력해줘.");
    return;
  }

  socket.emit("join", { roomCode: code }, (res) => {
    if (!res?.ok) {
      const msg = humanJoinErrorMessage(res?.error);
      log(`❌ ${msg}`);
      if (elRoomHint) elRoomHint.textContent = msg;
      return;
    }

    roomCode = res.roomCode;
    log(`✅ Room '${roomCode}'에 들어왔어. (친구도 같은 코드로 Join!)`);
    if (elRoomHint) elRoomHint.textContent = `Joined: ${roomCode} (친구도 같은 코드 입력!)`;
  });
});

elRoom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") elJoin.click();
});

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

/* Send word */
elSend.addEventListener("click", () => {
  const w = (elWord.value || "").trim();
  if (!roomCode) {
    log("❌ 먼저 Room에 Join 해줘.");
    return;
  }
  if (!w) return;

  socket.emit("play", { roomCode, word: w });
  elWord.value = "";
  elWord.focus();
});

elWord.addEventListener("keydown", (e) => {
  if (e.key === "Enter") elSend.click();
});

/* server events */
socket.on("system", ({ message }) => {
  if (message) log(`• ${message}`);
});

socket.on("state", ({ players, currentWord, turn }) => {
  if (elPlayersText) elPlayersText.textContent = `Players: ${players.length}/2`;
  elCurrentWord.textContent = currentWord || "(none)";
  setMustStart(currentWord);
  setTurn(turn);

  if (!turn || players.length < 2) resetTimerUI();
});

socket.on("timer", ({ deadline: dl, turn, timeLimitMs: tl }) => {
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

socket.on("accept", ({ word, nextTurn }) => {
  elCurrentWord.textContent = word;
  setMustStart(word);
  setTurn(nextTurn);
  log(`✅ 인정! 다음 단어를 이어가자.`);
});

socket.on("reject", (r) => {
  // ✅ 여기서 “코드”를 직접 출력하지 않음
  log(`❌ ${humanRejectMessage(r)}`);
});

socket.on("round_end", ({ reason, winner }) => {
  const winText = winner === myId ? "YOU" : "OPPONENT";
  const msg = (reason === "timeout") ? "시간 초과로 라운드 종료!" : "라운드 종료!";
  log(`🏁 ${msg} 승자: ${winText}`);
  elCurrentWord.textContent = "(none)";
  setMustStart("");
  resetTimerUI();
});

socket.on("player_left", () => {
  log("• 상대가 나갔어. 새로 들어올 때까지 기다려줘.");
  resetTimerUI();
});