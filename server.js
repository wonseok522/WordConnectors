import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const KRDIC_KEY = process.env.KRDIC_KEY; // 터미널에서 export KRDIC_KEY=...

// roomCode -> roomState
const rooms = new Map();

function isHangulWord(w) {
  return /^[가-힣]+$/.test(w);
}

function lastSyllable(word) {
  return word[word.length - 1];
}

async function isValidKoreanDictionaryWord(word) {
  // 국립국어원 한국어기초사전 Open API (XML)
  if (!KRDIC_KEY) return false;

  const params = new URLSearchParams({
    key: KRDIC_KEY,
    q: word,
    part: "word",
    sort: "dict",
    start: "1",
    num: "20"
  });

  const url = `https://krdict.korean.go.kr/api/search?${params.toString()}`;
  const res = await fetch(url);
  const text = await res.text();

  // 간단 XML 스크래핑: <word>...</word> 값을 전부 뽑아서 exact match
  const words = [...text.matchAll(/<word>([^<]+)<\/word>/g)].map(m => m[1].trim());
  return words.includes(word);
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      players: [],        // socket ids
      currentWord: "",
      turn: null,
      usedWords: new Set(),
      timer: null,
      deadline: 0,
      timeLimitMs: 10000
    });
  }
  return rooms.get(roomCode);
}

function emitState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  io.to(roomCode).emit("state", {
    players: room.players,
    currentWord: room.currentWord,
    turn: room.turn
  });
}

function startTurnTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  if (room.timer) clearTimeout(room.timer);

  room.deadline = Date.now() + room.timeLimitMs;

  io.to(roomCode).emit("timer", {
    deadline: room.deadline,
    turn: room.turn,
    timeLimitMs: room.timeLimitMs
  });

  room.timer = setTimeout(() => {
    const loser = room.turn;
    const winner = room.players.find(id => id !== loser) || null;

    io.to(roomCode).emit("round_end", {
      reason: "timeout",
      winner,
      loser
    });

    // 다음 라운드 리셋 (MVP)
    room.currentWord = "";
    room.usedWords.clear();
    room.turn = winner;

    emitState(roomCode);

    if (winner) startTurnTimer(roomCode);
  }, room.timeLimitMs + 80);
}

io.on("connection", (socket) => {
  socket.on("join", ({ roomCode }) => {
    const room = getRoom(roomCode);

    if (room.players.length >= 2) {
      socket.emit("join_error", { message: "Room is full (2 players max)." });
      return;
    }

    socket.join(roomCode);
    room.players.push(socket.id);

    // 첫번째 플레이어가 선
    if (room.players.length === 1) room.turn = socket.id;

    emitState(roomCode);

    if (room.players.length === 2) {
      startTurnTimer(roomCode);
    }
  });

  socket.on("play", async ({ roomCode, word }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    word = (word || "").trim();

    // 1) 턴 체크
    if (socket.id !== room.turn) {
      socket.emit("reject", { reason: "not_your_turn" });
      return;
    }

    // 2) 시간 체크
    if (Date.now() > room.deadline) {
      socket.emit("reject", { reason: "too_late" });
      return;
    }

    // 3) 한글만
    if (!isHangulWord(word)) {
      socket.emit("reject", { reason: "not_hangul" });
      return;
    }

    // 4) 끝말잇기 규칙
    if (room.currentWord) {
      const mustStart = lastSyllable(room.currentWord);
      if (word[0] !== mustStart) {
        socket.emit("reject", { reason: "wrong_start", mustStart });
        return;
      }
    }

    // 5) 중복 금지
    if (room.usedWords.has(word)) {
      socket.emit("reject", { reason: "already_used" });
      return;
    }

    // 6) 사전 검증
    const ok = await isValidKoreanDictionaryWord(word);
    if (!ok) {
      socket.emit("reject", { reason: "not_in_dictionary" });
      return;
    }

    // 승인
    room.currentWord = word;
    room.usedWords.add(word);

    // 턴 넘기기
    room.turn = room.players.find(id => id !== socket.id) || socket.id;

    io.to(roomCode).emit("accept", {
      word,
      nextTurn: room.turn
    });

    emitState(roomCode);
    startTurnTimer(roomCode);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);

        if (room.timer) clearTimeout(room.timer);

        io.to(code).emit("player_left", { id: socket.id });

        if (room.players.length === 0) {
          rooms.delete(code);
        } else {
          room.turn = room.players[0];
          emitState(code);
          startTurnTimer(code);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`WordConnector running on http://localhost:${PORT}`);
});