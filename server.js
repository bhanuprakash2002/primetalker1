// server.js - Azure Ready Express + WebSocket Server

// Load .env ONLY in development
if (process.env.NODE_ENV !== "production") {
    require("dotenv").config();
}

// Force immediate log output
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
if (process.stderr._handle) process.stderr._handle.setBlocking(true);

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const path = require("path");

// Twilio Video Token
const { AccessToken } = require("twilio").jwt;
const { VideoGrant } = AccessToken;

const app = express();
app.use(express.json());

// ===== CORS (adjust domain in production if needed) =====
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // change in prod
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.static(path.join(__dirname, "public")));

// ===== In-memory sessions =====
const activeSessions = new Map();

// ===== Health check =====
app.get("/health", (req, res) => {
    res.json({ status: "ok", activeRooms: activeSessions.size });
});

// =====================================================
// 🎥 TWILIO VIDEO TOKEN
// =====================================================
app.post("/api/video-token", (req, res) => {
    try {
        const { identity, roomName } = req.body;

        if (!identity || !roomName) {
            return res.status(400).json({ error: "Missing identity or roomName" });
        }

        const {
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_SECRET
        } = process.env;

        if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_SECRET) {
            console.error("❌ Missing Twilio credentials");
            return res.status(500).json({ error: "Twilio not configured" });
        }

        const token = new AccessToken(
            TWILIO_ACCOUNT_SID,
            TWILIO_API_KEY_SID,
            TWILIO_API_SECRET,
            { identity }
        );

        const videoGrant = new VideoGrant({ room: roomName });
        token.addGrant(videoGrant);

        console.log("✅ Video token generated:", identity, roomName);

        res.json({ token: token.toJwt() });

    } catch (error) {
        console.error("❌ Video token error:", error);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

// =====================================================
// 🏠 ROOM MANAGEMENT
// =====================================================

// Create room
app.post("/create-room", (req, res) => {
    try {
        const { creatorLanguage, creatorName } = req.body;

        const roomId = uuidv4().substring(0, 8);

        activeSessions.set(roomId, {
            creatorLanguage,
            creatorName,
            participantLanguage: null,
            participantName: null,
            callerConnection: null,
            receiverConnection: null,
            createdAt: Date.now()
        });

        const joinUrl = `${req.protocol}://${req.get("host")}/join.html?room=${roomId}`;

        console.log("✅ Room created:", roomId);

        res.json({ roomId, joinUrl });

    } catch (error) {
        console.error("❌ Create room error:", error);
        res.status(500).json({ error: "Failed to create room" });
    }
});

// Join room
app.post("/join-room", (req, res) => {
    try {
        const { roomId, participantLanguage, participantName } = req.body;
        const session = activeSessions.get(roomId);

        if (!session) {
            return res.status(404).json({ error: "Room not found" });
        }

        session.participantLanguage = participantLanguage;
        session.participantName = participantName;

        console.log("✅ Joined room:", roomId);

        res.json({
            success: true,
            creatorLanguage: session.creatorLanguage,
            creatorName: session.creatorName
        });

    } catch (error) {
        console.error("❌ Join error:", error);
        res.status(500).json({ error: "Failed to join room" });
    }
});

// Room info
app.get("/room-info", (req, res) => {
    const session = activeSessions.get(req.query.roomId);

    if (!session) {
        return res.status(404).json({ error: "Room not found" });
    }

    res.json(session);
});

// Leave room
app.post("/leave-room", (req, res) => {
    try {
        const { roomId, userType } = req.body;
        const session = activeSessions.get(roomId);

        if (session) {
            if (userType === "caller") {
                session.callerConnection?.ws?.close();
                session.receiverConnection?.ws?.close();
                activeSessions.delete(roomId);
                console.log("🗑️ Room deleted:", roomId);
            } else {
                session.receiverConnection?.ws?.close();
                session.receiverConnection = null;
                session.participantLanguage = null;
                session.participantName = null;
                console.log("👋 Participant left:", roomId);
            }
        }

        res.json({ success: true });

    } catch (error) {
        console.error("❌ Leave error:", error);
        res.status(500).json({ error: "Failed to leave room" });
    }
});

// =====================================================
// 🔊 WEBSOCKET SERVER
// =====================================================

const VoiceProcessor = require("./voice-processor");
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws, req) => {
    console.log("🔗 WebSocket connected");

    const processor = new VoiceProcessor(ws, activeSessions);

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);
            await processor.handleMessage(data);
        } catch (err) {
            console.error("❌ WS message error:", err.message);
        }
    });

    ws.on("close", () => {
        console.log("❌ WebSocket closed");
        processor.cleanup();
    });

    ws.on("error", (err) => {
        console.error("❌ WS error:", err.message);
        processor.cleanup();
    });
});

// =====================================================
// 🚀 START SERVER
// =====================================================

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

// WebSocket upgrade (FIXED for Azure)
server.on("upgrade", (req, socket, head) => {
    if (req.url.startsWith("/audio-stream")) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    } else {
        socket.destroy();
    }
});