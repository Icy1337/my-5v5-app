require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// In-memory store: rooms -> { players: [], adminName: string | null }
let rooms = {};

app.use(express.static(path.join(__dirname, "public")));
// If you want to parse form data, do:
// app.use(express.urlencoded({ extended: true }));

// ==============  ROUTES  ==============
app.get("/", (req, res) => {
    // Serve the homepage
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/room/:roomId", (req, res) => {
    // Serve the room page
    res.sendFile(path.join(__dirname, "public", "room.html"));
});

// A hidden admin page with drag & drop
// The path can be anything you want, e.g. /secret-admin
app.get("/secret-admin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin-dnd.html"));
});

// ==============  SOCKET.IO  ==============
io.on("connection", (socket) => {
    socket.on("adminWatchRoom", ({ roomId, password }) => {
        // Check admin password
        if (!password || password !== process.env.ADMIN_PASSWORD) {
            socket.emit("rigError", "Invalid password");
            return;
        }
        // If valid, join the same room so admin can receive "updatePlayers"
        if (rooms[roomId]) {
            socket.join(roomId); // same socket.io room
            // Immediately send the current players
            socket.emit("updatePlayers", rooms[roomId].players);
        } else {
            socket.emit("rigError", "Room does not exist");
        }
    });

    console.log("A user connected:", socket.id);

    // 1) Join room
    socket.on("joinRoom", ({ roomId, playerName, isHost }) => {
        // If room doesn't exist, create it
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                adminName: null, // We'll track admin by name
            };
        }

        // If the room is full
        if (rooms[roomId].players.length >= 10) {
            socket.emit("joinError", "Room is full (max 10).");
            return;
        }

        // Check for duplicate nickname
        const nameExists = rooms[roomId].players.some(
            (p) => p.name.toLowerCase() === playerName.toLowerCase(),
        );
        if (nameExists) {
            socket.emit("joinError", "Nickname already taken.");
            return;
        }

        socket.join(roomId);

        // If the room has no admin yet, or we say "isHost" from localStorage, set admin
        if (!rooms[roomId].adminName || isHost) {
            // We can either force them to be admin or only set them if adminName is null:
            if (!rooms[roomId].adminName) {
                rooms[roomId].adminName = playerName;
            } else if (rooms[roomId].adminName === playerName) {
                // If user re-joined w/ same name, they keep admin
                // (Alternatively, you might only set them if adminName = null)
            }
        }

        // Assign a random color
        const color = getRandomColor();

        // Add the new player
        rooms[roomId].players.push({
            id: socket.id,
            name: playerName,
            color,
            x: 0,
            y: 0,
        });

        // Send updated players to room
        io.to(roomId).emit("updatePlayers", rooms[roomId].players);
    });

    // 2) Cursor movement
    socket.on("cursorMove", ({ roomId, x, y }) => {
        if (!rooms[roomId]) return;
        const player = rooms[roomId].players.find((p) => p.id === socket.id);
        if (player) {
            player.x = x;
            player.y = y;
        }
        io.to(roomId).emit("updatePlayers", rooms[roomId].players);
    });

    socket.on("startRandomTeams", (roomId) => {
        if (!rooms[roomId]) return;
        if (rooms[roomId].players.length < 10) {
            io.to(roomId).emit("teamsGenerated", {
                error: "Not enough players (need 10).",
            });
            return;
        }

        // 1) Tell everyone to start drumroll
        io.to(roomId).emit("startDrumroll");

        // 2) After 3s, generate random teams
        setTimeout(() => {
            const players = rooms[roomId].players;
            const shuffled = [...players].sort(() => 0.5 - Math.random());
            const teamA = shuffled
                .slice(0, 5)
                .map((p) => ({ name: p.name, color: p.color }));
            const teamB = shuffled
                .slice(5, 10)
                .map((p) => ({ name: p.name, color: p.color }));
            io.to(roomId).emit("teamsGenerated", { teamA, teamB });
        }, 6000);
    });

    socket.on("rigTeamsRequest", ({ roomId, password, teamA, teamB }) => {
        // Validate
        if (!password || password !== process.env.ADMIN_PASSWORD) {
            socket.emit("rigError", "Invalid password.");
            return;
        }
        if (!rooms[roomId] || rooms[roomId].players.length < 10) {
            socket.emit(
                "rigError",
                "Room not found or not enough players (need 10).",
            );
            return;
        }
        if (teamA.length !== 5 || teamB.length !== 5) {
            socket.emit("rigError", "Each team must have exactly 5 players.");
            return;
        }
        const allNames = rooms[roomId].players.map((p) => p.name);
        const validAll = [...teamA, ...teamB].every((n) =>
            allNames.includes(n),
        );
        if (!validAll) {
            socket.emit("rigError", "Some names not found in the room.");
            return;
        }

        // Build final teams
        const getP = (n) => rooms[roomId].players.find((p) => p.name === n);
        const finalTeamA = teamA.map((n) => ({
            name: n,
            color: getP(n).color,
        }));
        const finalTeamB = teamB.map((n) => ({
            name: n,
            color: getP(n).color,
        }));

        // 1) Everyone starts drumroll
        io.to(roomId).emit("startDrumroll");

        // 2) After 3s, send teams
        setTimeout(() => {
            io.to(roomId).emit("teamsGenerated", {
                teamA: finalTeamA,
                teamB: finalTeamB,
            });
            socket.emit("rigTeamsSuccess", "Teams rigged successfully!");
        }, 6000);
    });

    // 5) Cleanup on disconnect
    socket.on("disconnect", () => {
        for (let rId in rooms) {
            const index = rooms[rId].players.findIndex(
                (p) => p.id === socket.id,
            );
            if (index !== -1) {
                const removed = rooms[rId].players.splice(index, 1)[0];

                // If the removed player was the admin, we either:
                // - Set adminName to null, so the next user can become admin
                // - Or do a more advanced logic if you want the admin to remain admin by name
                if (rooms[rId].adminName === removed.name) {
                    rooms[rId].adminName = null;
                }

                // If room is empty, delete it
                if (rooms[rId].players.length === 0) {
                    delete rooms[rId];
                } else {
                    io.to(rId).emit("updatePlayers", rooms[rId].players);
                }
                break;
            }
        }
    });
});

// Helper for random color
function getRandomColor() {
    const r = Math.floor(Math.random() * 205 + 50);
    const g = Math.floor(Math.random() * 205 + 50);
    const b = Math.floor(Math.random() * 205 + 50);
    return `rgb(${r}, ${g}, ${b})`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
