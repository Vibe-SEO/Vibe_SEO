const path = require("node:path");
const http = require("node:http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true, credentials: true }
});

const rawPort = process.env.PORT;
const normalizedPort = rawPort === undefined ? 3000 : Number.parseInt(rawPort, 10);
const port = Number.isInteger(normalizedPort) && normalizedPort >= 0 && normalizedPort <= 65535
    ? normalizedPort
    : 3000;

function startServer(portToTry) {
    server.once("error", function (error) {
        if (error && error.code === "EADDRINUSE") {
            const nextPort = portToTry + 1;
            if (nextPort > 65535) {
                console.error("No free port available in range 0-65535");
                process.exit(1);
            }
            console.warn(`Port ${portToTry} is busy, retrying on ${nextPort}`);
            startServer(nextPort);
            return;
        }

        throw error;
    });

    server.listen(portToTry, "0.0.0.0", function () {
        console.log(`VIBE server listening on http://localhost:${portToTry}`);
    });
}

/** @type {Map<string, {
 *   code: string,
 *   platform: string,
 *   videoUrl: string,
 *   name: string,
 *   position: number,
 *   playing: boolean,
 *   updatedAt: number,
 *   hostId: string | null
 * }>} */
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
        updatedAt: room.updatedAt,
        hostId: room.hostId || null,
        users: io.sockets.adapter.rooms.get(room.code)?.size || 0
    };
}

async function broadcastRoom(room) {
    const sockets = await io.in(room.code).fetchSockets();
    io.to(room.code).emit("room:users", {
        count: sockets.length,
        participants: sockets.map(function (member) {
            return {
                id: member.id,
                joinedAt: member.data.joinedAt || Date.now(),
                isHost: member.id === room.hostId
            };
        }),
        hostId: room.hostId
    });
}

async function transferHost(room, excludeSocketId) {
    const sockets = await io.in(room.code).fetchSockets();
    const next = sockets.find(function (s) {
        return s.id !== excludeSocketId;
    });
    room.hostId = next ? next.id : null;
    if (next) {
        io.to(room.code).emit("room:host", { hostId: room.hostId });
    }
    await broadcastRoom(room);
}

io.on("connection", function (socket) {
    socket.on("room:create", function (payload, callback) {
        const code = cleanRoomCode(payload && payload.code);
        if (!code) {
            callback?.({ ok: false, error: "Неверный код комнаты." });
            return;
        }

        // Если комната уже есть и пустая/мертвая — можно пересоздать тем же кодом
        const existing = rooms.get(code);
        if (existing) {
            const size = io.sockets.adapter.rooms.get(code)?.size || 0;
            if (size > 0) {
                callback?.({ ok: false, error: "Комната уже существует." });
                return;
            }
            rooms.delete(code);
        }

        const room = {
            code,
            platform: String(payload.platform || ""),
            videoUrl: String(payload.videoUrl || ""),
            name: String(payload.name || "Вечер кино").slice(0, 80),
            position: 0,
            playing: false,
            updatedAt: Date.now(),
            hostId: socket.id
        };
        rooms.set(code, room);

        if (socket.data.roomCode && socket.data.roomCode !== code) {
            socket.leave(socket.data.roomCode);
        }
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.joinedAt = Date.now();
        socket.data.isHost = true;

        callback?.({ ok: true, room: snapshot(room), isHost: true });
        broadcastRoom(room);
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
        socket.data.joinedAt = Date.now();

        // Если хоста нет (отключился) — первый зашедший становится хостом
        if (!room.hostId) {
            room.hostId = socket.id;
        }
        socket.data.isHost = socket.id === room.hostId;

        callback?.({
            ok: true,
            room: snapshot(room),
            isHost: socket.data.isHost
        });
        broadcastRoom(room);

        // Сразу отдать актуальное состояние плеера новому участнику
        socket.emit("room:playback", {
            position: positionAt(room),
            playing: room.playing,
            updatedAt: room.updatedAt,
            source: "server"
        });
    });

    socket.on("room:playback", function (payload) {
        const room = getRoom(socket.data.roomCode);
        if (!room || !payload) return;

        // Только хост управляет синхронизацией
        if (room.hostId && socket.id !== room.hostId) {
            socket.emit("room:error", { error: "Только хост комнаты управляет воспроизведением." });
            return;
        }

        // Если хост ещё не назначен — назначаем того, кто первый прислал playback
        if (!room.hostId) {
            room.hostId = socket.id;
            socket.data.isHost = true;
            io.to(room.code).emit("room:host", { hostId: room.hostId });
        }

        const position = Math.max(0, Number(payload.position) || 0);
        room.position = position;
        room.playing = Boolean(payload.playing);
        room.updatedAt = Date.now();

        socket.to(room.code).emit("room:playback", {
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
        const room = getRoom(code);
        const wasHost = room && room.hostId === socket.id;
        socket.leave(code);
        socket.data.roomCode = null;
        socket.data.joinedAt = null;
        socket.data.isHost = false;
        if (room) {
            if (wasHost) {
                transferHost(room, socket.id);
            } else {
                broadcastRoom(room);
            }
        }
    });

    socket.on("disconnect", function () {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = getRoom(code);
        if (!room) return;
        const wasHost = room.hostId === socket.id;
        if (wasHost) {
            transferHost(room, socket.id);
        } else {
            broadcastRoom(room);
        }
    });
});

// Мягкий clock: раз в 2с шлём эталонное время от сервера (только если играет)
setInterval(function () {
    for (const room of rooms.values()) {
        if (!room.playing) continue;
        io.to(room.code).emit("room:clock", {
            position: positionAt(room),
            playing: true,
            updatedAt: room.updatedAt,
            hostId: room.hostId
        });
    }
}, 2000);

// Чистим пустые комнаты раз в 5 минут
setInterval(function () {
    for (const [code, room] of rooms.entries()) {
        const size = io.sockets.adapter.rooms.get(code)?.size || 0;
        if (size === 0) {
            rooms.delete(code);
        }
    }
}, 5 * 60 * 1000);

startServer(port);
