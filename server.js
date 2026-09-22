const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true, credentials: true }
});

const port = Number(process.env.PORT) || 3000;
const rooms = new Map();

app.use(express.static(__dirname));

app.get("/health", function (_request, response) {
    response.json({ ok: true, rooms: rooms.size });
});

function cleanRoomCode(value) {
    return String(value || "").trim().toUpperCase().slice(0, 32);
}

function getRoom(code) {
    return rooms.get(cleanRoomCode(code));
}

function positionAt(room, now = Date.now()) {
    if (!room.playing) return room.position;
    return room.position + (now - room.updatedAt) / 1000;
}

function snapshot(room) {
    return {
        code: room.code,
        platform: room.platform,
        videoUrl: room.videoUrl,
        name: room.name,
        position: Math.max(0, positionAt(room)),
        playing: room.playing,
        updatedAt: Date.now(),
        users: io.sockets.adapter.rooms.get(room.code)?.size || 0
    };
}

function broadcastRoom(room) {
    io.to(room.code).emit("room:users", {
        count: io.sockets.adapter.rooms.get(room.code)?.size || 0
    });
}

io.on("connection", function (socket) {
    socket.on("room:create", function (payload, callback) {
        const code = cleanRoomCode(payload && payload.code);
        if (!code || rooms.has(code)) {
            callback?.({ ok: false, error: "Комната уже существует или имеет неверный код." });
            return;
        }

        const room = {
            code,
            platform: String(payload.platform || ""),
            videoUrl: String(payload.videoUrl || ""),
            name: String(payload.name || "Вечер кино").slice(0, 80),
            position: 0,
            playing: false,
            updatedAt: Date.now()
        };
        rooms.set(code, room);
        callback?.({ ok: true, room: snapshot(room) });
    });

    socket.on("room:join", function (payload, callback) {
        const room = getRoom(payload && payload.code);
        if (!room) {
            callback?.({ ok: false, error: "Комната не найдена или сервер был перезапущен." });
            return;
        }

        if (socket.data.roomCode && socket.data.roomCode !== room.code) {
            socket.leave(socket.data.roomCode);
        }
        socket.join(room.code);
        socket.data.roomCode = room.code;
        callback?.({ ok: true, room: snapshot(room) });
        broadcastRoom(room);
    });

    socket.on("room:playback", function (payload) {
        const room = getRoom(socket.data.roomCode);
        if (!room || !payload) return;

        const position = Math.max(0, Number(payload.position) || 0);
        room.position = position;
        room.playing = Boolean(payload.playing);
        room.updatedAt = Date.now();
        io.to(room.code).emit("room:playback", {
            position: positionAt(room),
            playing: room.playing,
            updatedAt: room.updatedAt,
            source: socket.id
        });
    });

    socket.on("room:chat", function (payload) {
        const room = getRoom(socket.data.roomCode);
        const text = String(payload && payload.text || "").trim().slice(0, 200);
        if (!room || !text) return;
        io.to(room.code).emit("room:chat", {
            username: String(payload.username || "Участник").slice(0, 32),
            text
        });
    });

    socket.on("room:leave", function () {
        const code = socket.data.roomCode;
        if (!code) return;
        socket.leave(code);
        socket.data.roomCode = null;
        const room = getRoom(code);
        if (room) broadcastRoom(room);
    });

    socket.on("disconnect", function () {
        const room = getRoom(socket.data.roomCode);
        if (room) broadcastRoom(room);
    });
});

setInterval(function () {
    for (const room of rooms.values()) {
        if (!room.playing) continue;
        io.to(room.code).emit("room:clock", {
            position: positionAt(room),
            playing: true,
            updatedAt: room.updatedAt
        });
    }
}, 2000);

server.listen(port, "0.0.0.0", function () {
    console.log(`VIBE server listening on http://localhost:${port}`);
});

// === НАДЕЖНЫЙ МОСТ СИНХРОНИЗАЦИИ (В КОНЕЦ ФАЙЛА SERVER.JS) ===
if (typeof io !== 'undefined') {
    io.on('connection', (socket) => {
        
        // 1. Гость зашел и сообщает об этом
        socket.on('request-current-video', (data) => {
            const roomId = data.roomId;
            socket.join(roomId); // Включаем гостя в комнату сокетов
            
            // Запрашиваем актуальное видео у Создателя комнаты (у остальных участников)
            socket.to(roomId).emit('get-creator-video-state', { requesterId: socket.id });
        });

        // 2. Создатель услышал запрос, взял ссылку из своего плеера и прислал серверу
        socket.on('reply-creator-video-state', (data) => {
            // Сервер перенаправляет эту ссылку лично тому гостю, который её просил
            if (data.requesterId) {
                io.to(data.requesterId).emit('room-init-video', {
                    videoUrl: data.videoUrl,
                    platform: data.platform,
                    seconds: data.seconds,
                    isPlaying: data.isPlaying
                });
            }
        });
    });
}

// В самом конце файла server.js проверим, пересылает ли сервер комнату
if (typeof io !== 'undefined') {
    io.on('connection', (socket) => {
        // Пересылка стандартных команд room:playback для ПК версий
        socket.on("room:playback", (data) => {
            if (data && data.roomId) {
                socket.to(data.roomId).emit("room:playback", data);
            } else {
                socket.broadcast.emit("room:playback", data); // отправка всем на случай если roomId пустой
            }
        });
    });
}
