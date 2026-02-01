import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const KRDIC_KEY = process.env.KRDIC_KEY;

// roomCode -> roomState
const rooms = new Map();

function isHangulWord(w) {
  return /^[가-힣]+$/.test(w);
}

function lastSyllable(word) {
  return word[word.length - 1];
}

async function isValidKoreanDictionaryWord(word) {
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
  const xml = await res.text();

  const words = [...xml.matchAll(/<word>([^<]+)<\/word>/g)].map(m => m[1].trim());
  return words.includes(word);
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      players: [],
      currentWord: "",
      turn: null,
      usedWords: new Set(),
      timer: null,
      deadline: 0,
      timeLimitMs: 12000 // UI 크게 만들었으니 여유 있게 12초
    });
  }
  return rooms.get(roomCode);
}

function emitState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  io.to(roomCode).emit("state", {
    roomCode,
    players: room.players,
    currentWord: room.currentWord,
    turn: room.turn
  });
}

function startTurnTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.players.length < 2 || !room.turn) return;

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

    io.to(roomCode).emit("round_end", { reason: "timeout", winner, loser });

    room.currentWord = "";
    room.usedWords.clear();
    room.turn = winner;

    emitState(roomCode);
    startTurnTimer(roomCode);
  }, room.timeLimitMs + 80);
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  // ✅ Join with ACK (debug-friendly)
  socket.on("join", ({ roomCode }, ack) => {
    try {
      roomCode = (roomCode || "").trim();

      if (!roomCode) {
        ack?.({ ok: false, error: "empty_room_code" });
        return;
      }

      const room = getRoom(roomCode);

      if (room.players.length >= 2) {
        ack?.({ ok: false, error: "room_full" });
        return;
      }

      // Prevent duplicate join
      if (room.players.includes(socket.id)) {
        ack?.({ ok: true, roomCode, alreadyIn: true });
        emitState(roomCode);
        return;
      }

      socket.join(roomCode);
      room.players.push(socket.id);

      if (room.players.length === 1) room.turn = socket.id;

      console.log(`join room=${roomCode} players=${room.players.length}/2`);

      ack?.({ ok: true, roomCode, players: room.players.length });

      io.to(roomCode).emit("system", {
        message: `Player joined (${room.players.length}/2)`
      });

      emitState(roomCode);

      if (room.players.length === 2) startTurnTimer(roomCode);
    } catch (e) {
      console.error("join error", e);
      ack?.({ ok: false, error: "server_error" });
    }
  });

  socket.on("play", async ({ roomCode, word }, ack) => {
    const room = rooms.get(roomCode);
    if (!room) {
      ack?.({ ok: false, error: "room_not_found" });
      return;
    }

    word = (word || "").trim();

    if (!room.players.includes(socket.id)) {
      socket.emit("reject", { reason: "not_in_room" });
      ack?.({ ok: false, error: "not_in_room" });
      return;
    }

    if (room.players.length < 2) {
      socket.emit("reject", { reason: "waiting_for_opponent" });
      ack?.({ ok: false, error: "waiting_for_opponent" });
      return;
    }

    if (socket.id !== room.turn) {
      socket.emit("reject", { reason: "not_your_turn" });
      ack?.({ ok: false, error: "not_your_turn" });
      return;
    }

    if (Date.now() > room.deadline) {
      socket.emit("reject", { reason: "too_late" });
      ack?.({ ok: false, error: "too_late" });
      return;
    }

    if (!isHangulWord(word)) {
      socket.emit("reject", { reason: "not_hangul" });
      ack?.({ ok: false, error: "not_hangul" });
      return;
    }

    if (room.currentWord) {
      const mustStart = lastSyllable(room.currentWord);
      if (word[0] !== mustStart) {
        socket.emit("reject", { reason: "wrong_start", mustStart });
        ack?.({ ok: false, error: "wrong_start", mustStart });
        return;
      }
    }

    if (room.usedWords.has(word)) {
      socket.emit("reject", { reason: "already_used" });
      ack?.({ ok: false, error: "already_used" });
      return;
    }

    const ok = await isValidKoreanDictionaryWord(word);
    if (!ok) {
      socket.emit("reject", { reason: "not_in_dictionary" });
      ack?.({ ok: false, error: "not_in_dictionary" });
      return;
    }

    room.currentWord = word;
    room.usedWords.add(word);

    room.turn = room.players.find(id => id !== socket.id) || socket.id;

    io.to(roomCode).emit("accept", { word, nextTurn: room.turn });
    emitState(roomCode);
    startTurnTimer(roomCode);

    ack?.({ ok: true });
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);

    for (const [code, room] of rooms.entries()) {
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);

        if (room.timer) clearTimeout(room.timer);

        io.to(code).emit("player_left", { id: socket.id });

        room.currentWord = "";
        room.usedWords.clear();
        room.turn = room.players[0] ?? null;

        if (room.players.length === 0) {
          rooms.delete(code);
        } else {
          emitState(code);
          startTurnTimer(code);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`WordConnector running on http://localhost:${PORT}`);
  if (!KRDIC_KEY) console.log("WARNING: KRDIC_KEY not set -> dictionary validation will fail.");
});