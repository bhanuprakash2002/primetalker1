// voice-processor.js - Production-Grade Bidirectional Translation
// Adapted from servermain.js reference with WebSocket PCM audio (not Twilio)
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// ─── Google Cloud Credentials ─────────────────────────────────────────────────
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    try { googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); }
    catch (e) { console.error("Bad GOOGLE_CREDENTIALS:", e.message); }
}
const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};

// ─── Shared Singleton Clients ─────────────────────────────────────────────────
const sharedSpeechClient    = new speech.SpeechClient(clientConfig);
const sharedTtsClient       = new textToSpeech.TextToSpeechClient(clientConfig);
const sharedTranslateClient = new Translate(clientConfig);

// ─── Language Maps (from reference servermain.js) ─────────────────────────────
const STT_LANG_MAP = {
    en: "en-IN", hi: "hi-IN", te: "te-IN", ta: "ta-IN",
    kn: "kn-IN", ml: "ml-IN", mr: "mr-IN", bn: "bn-IN",
    gu: "gu-IN", pa: "pa-IN", ur: "ur-IN",
    es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT",
    pt: "pt-PT", ar: "ar-SA", ja: "ja-JP", ko: "ko-KR", zh: "zh-CN",
    ru: "ru-RU", nl: "nl-NL", pl: "pl-PL", tr: "tr-TR",
};

const TTS_VOICE_MAP = {
    en:  { languageCode: "en-US", name: "en-US-Neural2-J" },
    hi:  { languageCode: "hi-IN", name: "hi-IN-Neural2-A" },
    te:  { languageCode: "te-IN", name: "te-IN-Standard-A" },
    ta:  { languageCode: "ta-IN", name: "ta-IN-Standard-A" },
    kn:  { languageCode: "kn-IN", name: "kn-IN-Standard-A" },
    ml:  { languageCode: "ml-IN", name: "ml-IN-Standard-A" },
    mr:  { languageCode: "mr-IN", name: "mr-IN-Standard-A" },
    gu:  { languageCode: "gu-IN", name: "gu-IN-Standard-A" },
    pa:  { languageCode: "pa-IN", name: "pa-IN-Standard-A" },
    bn:  { languageCode: "bn-IN", name: "bn-IN-Standard-A" },
    es:  { languageCode: "es-ES", name: "es-ES-Neural2-A" },
    fr:  { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
    de:  { languageCode: "de-DE", name: "de-DE-Neural2-A" },
    pt:  { languageCode: "pt-BR", name: "pt-BR-Neural2-A" },
    it:  { languageCode: "it-IT", name: "it-IT-Neural2-A" },
    ru:  { languageCode: "ru-RU", name: "ru-RU-Standard-A" },
    zh:  { languageCode: "cmn-CN", name: "cmn-CN-Standard-A" },
    ja:  { languageCode: "ja-JP", name: "ja-JP-Neural2-B" },
    ko:  { languageCode: "ko-KR", name: "ko-KR-Neural2-A" },
    ar:  { languageCode: "ar-XA", name: "ar-XA-Standard-A" },
    tr:  { languageCode: "tr-TR", name: "tr-TR-Neural2-A" },
    nl:  { languageCode: "nl-NL", name: "nl-NL-Neural2-A" },
    pl:  { languageCode: "pl-PL", name: "pl-PL-Neural2-A" },
    vi:  { languageCode: "vi-VN", name: "vi-VN-Neural2-A" },
    th:  { languageCode: "th-TH", name: "th-TH-Neural2-C" },
};

// TTS output sample rate - must match WAV header
const TTS_SAMPLE_RATE = 24000;

// Silence thresholds (from reference: Telugu 700ms, others 900ms)
const SILENCE_MS = {
    default: 900,
    te: 700, hi: 800, ta: 800, kn: 800, ml: 800,
    mr: 800, bn: 800, gu: 800, pa: 800, ur: 800,
};

function getLangBase(lang) {
    return (lang || "en").split("-")[0].toLowerCase();
}

function getSttLangCode(lang) {
    const base = getLangBase(lang);
    return STT_LANG_MAP[base] || "en-IN";
}

function getTtsVoice(lang) {
    const base = getLangBase(lang);
    return TTS_VOICE_MAP[base] || { languageCode: STT_LANG_MAP[base] || "en-IN", ssmlGender: "NEUTRAL" };
}

function getSilenceMs(lang) {
    const base = getLangBase(lang);
    return SILENCE_MS[base] || SILENCE_MS.default;
}

// ─── WAV Header Builder ───────────────────────────────────────────────────────
function buildWav(pcmBuffer, sampleRate) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcmBuffer.length, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);  // PCM
    h.writeUInt16LE(1, 22);  // Mono
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * 2, 28);
    h.writeUInt16LE(2, 32);  // blockAlign
    h.writeUInt16LE(16, 34); // bitsPerSample
    h.write("data", 36);
    h.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([h, pcmBuffer]);
}

// ─── Per-speaker TTS queue (prevents overlap, from reference) ─────────────────
// Each VoiceProcessor instance has its own queue, so both speakers stay independent
function makeSerialQueue() {
    let last = Promise.resolve();
    return function enqueue(fn) {
        last = last.then(fn).catch(() => {});
        return last;
    };
}

// ─── Main VoiceProcessor Class ────────────────────────────────────────────────
class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws             = websocket;
        this.activeSessions = activeSessions;

        this.speechClient    = sharedSpeechClient;
        this.ttsClient       = sharedTtsClient;
        this.translateClient = sharedTranslateClient;

        // Identity
        this.roomId      = null;
        this.userType    = null;
        this.myLanguage  = null;
        this.myName      = null;

        // STT Stream
        this.recognizeStream  = null;
        this.isStreaming       = false;
        this.isStartingStream  = false;
        this.streamCreatedAt   = 0;
        this.audioBuffer       = [];

        // ── KEY: Reference-style utterance tracking ──────────────────────────
        // We track the CURRENT rolling interim text and the LAST text we committed.
        // On flush, we extract only the NEW delta (prevents sentence accumulation).
        this.currentUtterance       = "";  // latest interim from Google
        this.lastCommittedFullText  = "";  // last full text we extracted delta from
        this.lastSpeechTime         = Date.now();
        this.lastUtteranceChangeTime = Date.now();
        this.silenceChecker         = null;

        // TTS serial queue for this speaker (prevents overlap)
        this.ttsQueue = makeSerialQueue();

        // Duplicate prevention
        this.lastFlushTime = 0;      // timestamp of last flush sent
        this.lastFlushedText = "";   // exact text of last flush sent

        // Bind
        this._onSTTData  = this._onSTTData.bind(this);
        this._onSTTError = this._onSTTError.bind(this);
    }

    // ─── Public Message Handler ───────────────────────────────────────────────
    async handleMessage(msg) {
        switch (msg.event) {
            case "connected":
                this.roomId     = msg.roomId;
                this.userType   = msg.userType;
                this.myLanguage = msg.myLanguage;
                this.myName     = msg.myName || "User";
                console.log(`✅ [${this.userType}] room:${this.roomId} lang:${this.myLanguage}`);

                this._registerConnection();
                this._notifyPartner("user_joined", { name: this.myName, language: this.myLanguage });

                // Start STT stream via _restartStream so isRestarting flag is properly managed
                setTimeout(() => { if (!this.isStreaming && !this.isRestarting) this._restartStream(); }, 100);
                // Pre-warm Translation + TTS APIs
                this._warmUp();
                // Start silence-based flush checker (150ms polling)
                this._startSilenceChecker();
                // Health monitor (logs stream state every 10s for debugging)
                this._startHealthMonitor();
                break;

            case "audio":
                this._processAudio(msg.audio);
                break;

            case "video-offer":
                this._notifyPartner("video-offer", { sdp: msg.sdp });
                break;
            case "video-answer":
                this._notifyPartner("video-answer", { sdp: msg.sdp });
                break;
            case "ice-candidate":
                this._notifyPartner("ice-candidate", { candidate: msg.candidate });
                break;

            case "disconnect":
            case "stop":
                await this.cleanup();
                break;
        }
    }

    // ─── Audio Processing ─────────────────────────────────────────────────────
    _processAudio(base64Audio) {
        if (!this.myLanguage) return;
        const buffer = Buffer.from(base64Audio, "base64");
        this._audioChunkCount = (this._audioChunkCount || 0) + 1;

        // If stream is not ready, buffer and ensure a restart is queued
        if (this.isRestarting || this.isStartingStream || !this.isStreaming || !this.recognizeStream) {
            this.audioBuffer.push(buffer);
            if (this.audioBuffer.length > 100) this.audioBuffer.shift();
            // Trigger restart only if truly idle (not already in progress)
            if (!this.isRestarting && !this.isStartingStream) {
                this._restartStream();
            }
            return;
        }

        // Safety restart at 4-minute Google hard limit
        if (Date.now() - this.streamCreatedAt > 240000) {
            console.log("🔄 Safety restart (4 min limit)");
            this._restartStream();
            return;
        }

        // Write audio to live stream
        try {
            this.recognizeStream.write(buffer);
            this._audioWriteCount = (this._audioWriteCount || 0) + 1;
        } catch (e) {
            console.error("Stream write error:", e.message);
            this._restartStream();
        }
    }

    // ─── STT Stream Lifecycle ─────────────────────────────────────────────────
    async _startStream() {
        if (this.isStreaming || this.isStartingStream) return;
        this.isStartingStream = true;

        // Clear utterance state for new stream
        this.currentUtterance = "";
        this.lastCommittedFullText = ""; // reset only at stream start (beginning of call / 4-min restart)
        this.lastSpeechTime = Date.now();

        const langCode  = getSttLangCode(this.myLanguage);
        const isEnglish = getLangBase(this.myLanguage) === "en";

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({
                    config: {
                        encoding:                   "LINEAR16",
                        sampleRateHertz:            16000,
                        languageCode:               langCode,
                        enableAutomaticPunctuation: false,
                        // useEnhanced ONLY for English — not supported for Indian languages
                        // Using it for te-IN/hi-IN etc causes stream to be rejected silently
                        ...(isEnglish ? { useEnhanced: true, model: "latest_long" } : {}),
                    },
                    interimResults:  true,
                    singleUtterance: false,
                })
                .on("data",  this._onSTTData)
                .on("error", this._onSTTError)
                .on("end",   () => {
                    this.isStreaming     = false;
                    this.recognizeStream = null;
                    console.log(`🔴 STT stream ended [${langCode}]`);
                });

            this.isStreaming      = true;
            this.isStartingStream = false;
            this.streamCreatedAt  = Date.now();
            console.log(`🎤 STT stream started [${langCode}]`);

            // Replay buffered audio (captured during restart)
            if (this.audioBuffer.length > 0) {
                const chunks = this.audioBuffer.splice(0);
                chunks.forEach(c => { if (this.recognizeStream) this.recognizeStream.write(c); });
                console.log(`📡 Replayed ${chunks.length} buffered chunks`);
            }
        } catch (e) {
            console.error("Failed to start STT stream:", e.message);
            this.isStreaming      = false;
            this.isStartingStream = false;
        }
    }

    _stopStream() {
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }
        this.isStreaming = false;
    }

    async _restartStream() {
        if (this.isRestarting) return;
        this.isRestarting = true;
        try {
            this._stopStream();
            await this._startStream();
        } catch (e) {
            console.error("Restart error:", e.message);
        } finally {
            // CRITICAL: always release the lock, even if _startStream() throws
            this.isRestarting = false;
        }
    }

    // ─── STT Callbacks ────────────────────────────────────────────────────────
    _onSTTData(response) {
        const result = response.results?.[0];
        if (!result) return;

        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        this.lastSpeechTime = Date.now();

        if (result.isFinal) {
            // Google confirmed sentence — flush immediately, don't wait for silence timer
            if (transcript !== this.currentUtterance) {
                this.currentUtterance = transcript;
                this.lastUtteranceChangeTime = Date.now();
            }
            this._sendToUI({ event: "transcript_interim", text: transcript });
            this._flushUtterance("isFinal");
        } else {
            // Interim: track changes for silence-based flush
            if (transcript !== this.currentUtterance) {
                this.currentUtterance = transcript;
                this.lastUtteranceChangeTime = Date.now();
            }
            this._sendToUI({ event: "transcript_interim", text: transcript });
        }
    }

    _onSTTError(err) {
        const msg = err.message || "";
        const isNormal = msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11;
        if (!isNormal) console.error(`❌ STT Error [${this.myLanguage}]:`, msg);
        else console.log(`⏰ STT timeout (normal) [${this.myLanguage}]`);

        this.isStreaming = false;
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }

        // Flush whatever we had on error
        if (this.currentUtterance) {
            this._flushUtterance("error-recovery");
        }
    }

    // ─── Silence Checker (150ms poll, from reference) ─────────────────────────
    _startSilenceChecker() {
        if (this.silenceChecker) clearInterval(this.silenceChecker);

        this.silenceChecker = setInterval(() => {
            if (!this.currentUtterance) return;

            const now = Date.now();
            const silenceMs = getSilenceMs(this.myLanguage);

            const speechSilent     = now - this.lastSpeechTime > silenceMs;
            const utteranceStable  = now - this.lastUtteranceChangeTime > (getLangBase(this.myLanguage) === "te" ? 300 : 400);

            if (speechSilent && utteranceStable) {
                this._flushUtterance("silence");
            }
        }, 150);
    }

    // ─── Health Monitor ───────────────────────────────────────────────────────
    _startHealthMonitor() {
        if (this._healthInterval) clearInterval(this._healthInterval);
        this._healthInterval = setInterval(() => {
            const state = this.isRestarting ? "RESTARTING"
                : this.isStartingStream    ? "STARTING"
                : this.isStreaming         ? "STREAMING"
                : "DEAD";
            console.log(
                `[HEALTH ${this.userType}|${this.myLanguage}] ` +
                `stream=${state} ` +
                `audioIn=${this._audioChunkCount||0}/10s ` +
                `audioOut=${this._audioWriteCount||0}/10s ` +
                `buf=${this.audioBuffer.length} ` +
                `utterance="${this.currentUtterance.slice(0,30)}"`
            );
            // Auto-recover dead stream
            if (state === "DEAD" && (this._audioChunkCount||0) > 0) {
                console.warn(`\u26a0\ufe0f [${this.userType}] Stream DEAD but receiving audio \u2014 force restart`);
                this._restartStream();
            }
            this._audioChunkCount = 0;
            this._audioWriteCount = 0;
        }, 10000);
    }

    // ─── Core: Delta Flush (from reference) ──────────────────────────────────
    // The KEY insight from servermain.js:
    // Google STT accumulates text. We only send the NEW delta, not the full transcript.
    // This prevents "Hello hi how are you how are you how are you" style repetition.
    _flushUtterance(reason) {
        let fullText = this.currentUtterance.trim();
        if (!fullText) return;

        // Safety: drop extremely long jumps (>200 chars, >15 words) — raised limit for continuous stream
        if (fullText.length > 200 && fullText.split(" ").length > 15) {
            console.log(`⚠️ Dropped long utterance: "${fullText.substring(0, 50)}..."`);
            this.currentUtterance = "";
            return;
        }

        // Extract delta: only new words not in last committed text
        let deltaText = fullText;
        if (this.lastCommittedFullText && fullText.startsWith(this.lastCommittedFullText)) {
            deltaText = fullText.slice(this.lastCommittedFullText.length).trim();
        }

        if (!deltaText) {
            this.currentUtterance = "";
            return;
        }

        // ── DUPLICATE GUARD ──────────────────────────────────────────────────
        // Prevent the same text being sent twice (silence flush + isFinal race)
        const now = Date.now();
        const normalize = (t) => t.toLowerCase().replace(/[^\w\u0900-\u097F\u0C00-\u0C7F]/g, "").trim();
        if (
            normalize(deltaText) === normalize(this.lastFlushedText) &&
            now - this.lastFlushTime < 2000
        ) {
            console.log(`🚫 Duplicate suppressed: "${deltaText}"`);
            this.currentUtterance = "";
            return;
        }
        // ─────────────────────────────────────────────────────────────────────

        console.log(`\n🔵 [${this.myLanguage}] FLUSH (${reason}): "${deltaText}"\n`);

        this.lastCommittedFullText = fullText;
        this.lastFlushedText = deltaText;
        this.lastFlushTime = now;
        this.currentUtterance = "";

        // Restart stream to clear Google's context for the next sentence
        setImmediate(() => this._restartStream());

        // Send to translation pipeline
        this.ttsQueue(() => this._translateAndSend(deltaText));
    }

    // ─── Translation + TTS Pipeline ───────────────────────────────────────────
    async _translateAndSend(text) {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;

        const partner = this.userType === "caller"
            ? session.receiverConnection
            : session.callerConnection;

        if (!partner?.myLanguage) {
            console.log("⚠️ Partner not connected, dropping:", text);
            return;
        }

        const t0 = Date.now();

        // 1. Translate (with 6s timeout so a hung API call never blocks the queue)
        const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
        console.log(`🌐 [${Date.now() - t0}ms] "${text}" → "${translated}"`);

        // 2. Send text to BOTH UIs immediately — don't wait for TTS
        const payload = {
            event:          "translation",
            originalText:   text,
            translatedText: translated,
            fromUser:       this.userType,
            fromLanguage:   this.myLanguage,
            toLanguage:     partner.myLanguage,
        };
        this._sendToUI(payload);
        partner._sendToUI(payload);

        // 3. Generate TTS in BACKGROUND — does NOT block the translation queue
        //    This means the next sentence can translate immediately even if TTS is slow
        this._tts(translated, partner.myLanguage).then(audio => {
            if (!audio || partner.ws?.readyState !== 1) return;
            const hasRiff = audio.length >= 4 && audio.slice(0, 4).toString() === "RIFF";
            const wav = hasRiff ? audio : buildWav(audio, TTS_SAMPLE_RATE);
            partner.ws.send(JSON.stringify({
                event:  "audio_playback",
                audio:  wav.toString("base64"),
                format: "wav",
            }));
            console.log(`🔊 TTS done [${Date.now() - t0}ms total]`);
        }).catch(e => console.error("TTS background error:", e.message));
    }

    // ─── Google API Helpers ───────────────────────────────────────────────────
    // timeout helper
    _withTimeout(promise, ms, label) {
        return Promise.race([
            promise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
            )
        ]);
    }

    async _translate(text, from, to) {
        const fromBase = getLangBase(from);
        const toBase   = getLangBase(to);
        if (fromBase === toBase) return text;
        try {
            const [result] = await this._withTimeout(
                this.translateClient.translate(text, { from: fromBase, to: toBase }),
                6000, "Translate"
            );
            return result;
        } catch (e) {
            console.error("Translate error:", e.message);
            return text; // fallback: show original text
        }
    }

    async _tts(text, lang) {
        const voice = getTtsVoice(lang);
        try {
            const [res] = await this._withTimeout(
                this.ttsClient.synthesizeSpeech({
                    input:       { text },
                    voice,
                    audioConfig: {
                        audioEncoding:   "LINEAR16",
                        sampleRateHertz: TTS_SAMPLE_RATE,
                        speakingRate:    1.1,
                    },
                }),
                10000, "TTS" // 10s timeout
            );
            return res.audioContent;
        } catch (e) {
            console.error(`TTS error [${lang}]:`, e.message);
            return null;
        }
    }

    async _warmUp() {
        setTimeout(async () => {
            try {
                await Promise.all([
                    this.translateClient.translate("hello", { to: "en" }),
                    this.ttsClient.synthesizeSpeech({
                        input:       { text: "." },
                        voice:       { languageCode: "en-US" },
                        audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: TTS_SAMPLE_RATE },
                    }),
                ]);
                console.log("🔥 APIs warmed up");
            } catch (_) {}
        }, 300);
    }

    // ─── Room / WS Helpers ────────────────────────────────────────────────────
    _registerConnection() {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        if (this.userType === "caller") session.callerConnection   = this;
        else                            session.receiverConnection = this;
    }

    _sendToUI(data) {
        try {
            if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(data));
        } catch (_) {}
    }

    _notifyPartner(event, data) {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        const partner = this.userType === "caller"
            ? session.receiverConnection
            : session.callerConnection;
        if (partner?.ws?.readyState === 1) {
            partner.ws.send(JSON.stringify({ event, ...data }));
        }
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────────
    async cleanup() {
        if (this.silenceChecker) {
            clearInterval(this.silenceChecker);
            this.silenceChecker = null;
        }
        if (this._healthInterval) {
            clearInterval(this._healthInterval);
            this._healthInterval = null;
        }

        // Flush any remaining utterance
        if (this.currentUtterance) {
            this._flushUtterance("cleanup");
        }

        this._stopStream();

        const session = this.activeSessions.get(this.roomId);
        if (session) {
            if (session.callerConnection   === this) session.callerConnection   = null;
            if (session.receiverConnection === this) session.receiverConnection = null;
        }
        this._notifyPartner("user_left", {});
        console.log(`🧹 Cleanup: ${this.userType} in ${this.roomId}`);
    }
}

module.exports = VoiceProcessor;
