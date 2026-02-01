import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const KRDIC_KEY = process.env.KRDIC_KEY;

const MAX_PLAYERS = 4;
const rooms = new Map();

/* ---------------------------
   Hangul utils (for dueum variants)
--------------------------- */
const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
const JONG = ["", "ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

function isHangulSyllable(ch) {
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
  const code = 0xac00 + (cho * 588) + (jung * 28) + jong;
  return String.fromCharCode(code);
}

function isHangulWord(w) {
  return /^[가-힣]+$/.test(w);
}
function lastSyllable(word) {
  return word[word.length - 1];
}

/* ✅ 두음법칙 후보: 기본 + (가능하면) 변환 */
function dueumVariants(syllable) {
  const out = new Set([syllable]);
  const d = decomposeSyllable(syllable);
  if (!d) return [...out];

  const init = CHO[d.cho];
  const vowel = JUNG[d.jung];
  const yVowels = new Set(["ㅣ","ㅑ","ㅕ","ㅛ","ㅠ","ㅖ","ㅒ"]);

  // ㄹ -> ㄴ (항상), ㄹ -> ㅇ (특정 모음)
  if (init === "ㄹ") {
    out.add(composeSyllable(CHO.indexOf("ㄴ"), d.jung, d.jong));
    if (yVowels.has(vowel)) {
      out.add(composeSyllable(CHO.indexOf("ㅇ"), d.jung, d.jong));
    }
  }

  // ㄴ -> ㅇ (특정 모음)
  if (init === "ㄴ" && yVowels.has(vowel)) {
    out.add(composeSyllable(CHO.indexOf("ㅇ"), d.jung, d.jong));
  }

  return [...out];
}

/* ---------------------------
   Dictionary validation (fast-ish)
--------------------------- */
async function krdictSearch(q, num = 10) {
  if (!KRDIC_KEY) return { total: 0, words: [] };

  const params = new URLSearchParams({
    key: KRDIC_KEY,
    q,
    part: "word",
    sort: "dict",
    start: "1",
    num: String(num)
  });

  const url = `https://krdict.korean.go.kr/api/search?${params.toString()}`;
  const res = await fetch(url);
  const xml = await res.text();

  const m = xml.match(/<total>(\d+)<\/total>/);
  const total = m ? Number(m[1]) : 0;
  const words = [...xml.matchAll(/<word>([^<]+)<\/word>/g)].map(x => x[1].trim());
  return { total, words };
}

async function isValidKoreanDictionaryWord(word) {
  const r = await krdictSearch(word, 10);
  return r.total > 0;
}

/* ---------------------------
   Room state
--------------------------- */
function makePlayer(socket, nickname) {
  const shortId = socket.id.slice(0, 5);
  return {
    id: socket.id,
    name: (nickname || `Player-${shortId}`).slice(0, 18),
    score: 0
  };
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      roomCode,
      ownerId: null,
      state: "LOBBY", // LOBBY | RUNNING
      players: [],
      order: [],
      turnIndex: 0,
      currentWord: "",
      usedWords: new Set(),
      timer: null,
      deadline: 0,
      timeLimitMs: 12000,
      lastValidPlayerId: null
    });
  }
  return rooms.get(roomCode);
}

function stopTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = 0;
  io.to(room.roomCode).emit("timer_stop");
}

function getTurnId(room) {
  if (room.order.length === 0) return null;
  return room.order[room.turnIndex % room.order.length] ?? null;
}

function emitState(room) {
  io.to(room.roomCode).emit("state", {
    roomCode: room.roomCode,
    ownerId: room.ownerId,
    state: room.state,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    currentWord: room.currentWord,
    turn: room.state === "RUNNING" ? getTurnId(room) : null,
    timeLimitMs: room.timeLimitMs
  });
}

function resetRound(room, starterId = null) {
  stopTimer(room);
  room.currentWord = "";
  room.usedWords.clear();
  room.lastValidPlayerId = null;

  if (room.order.length > 0) {
    if (starterId && room.order.includes(starterId)) room.turnIndex = room.order.indexOf(starterId);
    else room.turnIndex = 0;
  } else {
    room.turnIndex = 0;
  }
}

function startTurnTimer(room) {
  stopTimer(room);

  if (room.state !== "RUNNING") return;
  if (room.order.length < 2) return;

  const turnId = getTurnId(room);
  if (!turnId) return;

  room.deadline = Date.now() + room.timeLimitMs;

  io.to(room.roomCode).emit("timer", {
    deadline: room.deadline,
    turn: turnId,
    timeLimitMs: room.timeLimitMs
  });

  room.timer = setTimeout(() => {
    const loser = turnId;

    let winner = room.lastValidPlayerId;
    if (!winner || winner === loser) {
      winner = room.order[(room.turnIndex + 1) % room.order.length] ?? null;
    }

    const wp = room.players.find(p => p.id === winner);
    if (wp) wp.score += 1;

    io.to(room.roomCode).emit("round_end", {
      reason: "timeout",
      winner,
      loser,
      scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
    });

    room.state = "LOBBY";
    resetRound(room, winner);
    emitState(room);
    stopTimer(room);
  }, room.timeLimitMs + 80);
}

function advanceTurn(room) {
  if (room.order.length === 0) return;
  room.turnIndex = (room.turnIndex + 1) % room.order.length;
}

/* ---------------------------
   Socket events
--------------------------- */
io.on("connection", (socket) => {
  socket.on("join", ({ roomCode, nickname }, ack) => {
    try {
      roomCode = (roomCode || "").trim();
      if (!roomCode) return ack?.({ ok: false, error: "empty_room_code" });

      const room = getRoom(roomCode);
      if (room.players.length >= MAX_PLAYERS) return ack?.({ ok: false, error: "room_full" });

      if (room.players.some(p => p.id === socket.id)) {
        ack?.({ ok: true, roomCode, alreadyIn: true, players: room.players.length });
        emitState(room);
        return;
      }

      socket.join(roomCode);
      const player = makePlayer(socket, nickname);
      room.players.push(player);
      room.order.push(socket.id);
      if (!room.ownerId) room.ownerId = socket.id;

      ack?.({ ok: true, roomCode, players: room.players.length, maxPlayers: MAX_PLAYERS });

      io.to(roomCode).emit("system", { message: `${player.name} joined (${room.players.length}/${MAX_PLAYERS})` });
      emitState(room);
    } catch {
      ack?.({ ok: false, error: "server_error" });
    }
  });

  socket.on("start_round", ({ roomCode }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: "room_not_found" });
    if (room.order.length < 2) return ack?.({ ok: false, error: "need_2_players" });
    if (room.state === "RUNNING") return ack?.({ ok: false, error: "already_running" });

    room.state = "RUNNING";
    resetRound(room, getTurnId(room));
    emitState(room);
    startTurnTimer(room);

    io.to(roomCode).emit("system", { message: "Round started." });
    ack?.({ ok: true });
  });

  socket.on("play", async ({ roomCode, word }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) return ack?.({ ok: false, error: "room_not_found" });

    if (room.state !== "RUNNING") {
      socket.emit("reject", { reason: "round_not_running" });
      return ack?.({ ok: false, error: "round_not_running" });
    }

    word = (word || "").trim();

    if (!room.order.includes(socket.id)) {
      socket.emit("reject", { reason: "not_in_room" });
      return ack?.({ ok: false, error: "not_in_room" });
    }

    if (room.order.length < 2) {
      socket.emit("reject", { reason: "waiting_for_opponent" });
      return ack?.({ ok: false, error: "waiting_for_opponent" });
    }

    const turnId = getTurnId(room);
    if (socket.id !== turnId) {
      socket.emit("reject", { reason: "not_your_turn" });
      return ack?.({ ok: false, error: "not_your_turn" });
    }

    if (Date.now() > room.deadline) {
      socket.emit("reject", { reason: "too_late" });
      return ack?.({ ok: false, error: "too_late" });
    }

    if (!isHangulWord(word)) {
      socket.emit("reject", { reason: "not_hangul" });
      return ack?.({ ok: false, error: "not_hangul" });
    }

    // ✅ 두음법칙 허용
    if (room.currentWord) {
      const required = lastSyllable(room.currentWord);
      const allowed = new Set(dueumVariants(required));
      if (!allowed.has(word[0])) {
        socket.emit("reject", { reason: "wrong_start", mustStartList: [...allowed] });
        return ack?.({ ok: false, error: "wrong_start" });
      }
    }

    if (room.usedWords.has(word)) {
      socket.emit("reject", { reason: "already_used" });
      return ack?.({ ok: false, error: "already_used" });
    }

    const ok = await isValidKoreanDictionaryWord(word);
    if (!ok) {
      socket.emit("reject", { reason: "not_in_dictionary" });
      return ack?.({ ok: false, error: "not_in_dictionary" });
    }

    // ✅ accept (한방단어 체크 제거!)
    room.currentWord = word;
    room.usedWords.add(word);
    room.lastValidPlayerId = socket.id;

    const player = room.players.find(p => p.id === socket.id);
    io.to(roomCode).emit("word_played", {
      by: player ? player.name : "Player",
      byId: socket.id,
      word
    });

    advanceTurn(room);

    io.to(roomCode).emit("accept", {
      word,
      nextTurn: getTurnId(room)
    });

    emitState(room);
    startTurnTimer(room);

    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      const name = room.players[idx]?.name ?? "Player";
      room.players.splice(idx, 1);

      const oidx = room.order.indexOf(socket.id);
      if (oidx !== -1) {
        if (oidx < room.turnIndex) room.turnIndex = Math.max(0, room.turnIndex - 1);
        room.order.splice(oidx, 1);
      }
      if (room.turnIndex >= room.order.length) room.turnIndex = 0;

      if (room.ownerId === socket.id) room.ownerId = room.order[0] ?? null;

      io.to(code).emit("system", { message: `${name} left.` });

      room.state = "LOBBY";
      resetRound(room, getTurnId(room));
      emitState(room);
      stopTimer(room);

      if (room.order.length === 0) rooms.delete(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`WordConnector running on http://localhost:${PORT}`);
  if (!KRDIC_KEY) console.log("WARNING: KRDIC_KEY not set -> dictionary validation will fail.");
});