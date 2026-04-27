// voice-processor.js - Clean Bidirectional Real-Time Translation
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// ─── Google Cloud Credentials ────────────────────────────────────────────────
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    try { googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); }
    catch (e) { console.error("Bad GOOGLE_CREDENTIALS env var:", e.message); }
}
const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};

// ─── Shared Singleton Clients (one per server process) ────────────────────────
const sharedSpeechClient    = new speech.SpeechClient(clientConfig);
const sharedTtsClient       = new textToSpeech.TextToSpeechClient(clientConfig);
const sharedTranslateClient = new Translate(clientConfig);

// ─── Language Helpers ─────────────────────────────────────────────────────────
const STT_LANG_MAP = {
    en: "en-IN",                                          // Indian-accented English
    hi: "hi-IN", te: "te-IN", ta: "ta-IN", kn: "kn-IN",
    ml: "ml-IN", mr: "mr-IN", gu: "gu-IN", pa: "pa-IN",
    bn: "bn-IN", ur: "ur-IN",
    es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
    it: "it-IT", nl: "nl-NL", pl: "pl-PL", ru: "ru-RU",
    zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR",
    ar: "ar-XA", tr: "tr-TR", he: "he-IL",
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

function getSttLangCode(lang) {
    const base = (lang || "en").split("-")[0].toLowerCase();
    return STT_LANG_MAP[base] || "en-IN";
}

function getTtsVoice(lang) {
    const base = (lang || "en").split("-")[0].toLowerCase();
    return TTS_VOICE_MAP[base] || { languageCode: getSttLangCode(lang), ssmlGender: "NEUTRAL" };
}

function getLangBase(lang) {
    return (lang || "en").split("-")[0].toLowerCase();
}

// TTS_SAMPLE_RATE - must be consistent everywhere
const TTS_SAMPLE_RATE = 24000;

// ─── WAV Builder ──────────────────────────────────────────────────────────────
function buildWav(pcmBuffer, sampleRate) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);
    h.writeUInt32LE(36 + pcmBuffer.length, 4);
    h.write("WAVE", 8);
    h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);   // PCM
    h.writeUInt16LE(1, 22);   // mono
    h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * 2, 28); // byteRate
    h.writeUInt16LE(2, 32);   // blockAlign
    h.writeUInt16LE(16, 34);  // bitsPerSample
    h.write("data", 36);
    h.writeUInt32LE(pcmBuffer.length, 40);
    return Buffer.concat([h, pcmBuffer]);
}

// ─── Main Class ───────────────────────────────────────────────────────────────
class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws             = websocket;
        this.activeSessions = activeSessions;

        // Shared Google clients
        this.speechClient    = sharedSpeechClient;
        this.ttsClient       = sharedTtsClient;
        this.translateClient = sharedTranslateClient;

        // Room / user identity
        this.roomId      = null;
        this.userType    = null;
        this.myLanguage  = null;
        this.myName      = null;

        // STT stream state
        this.recognizeStream    = null;
        this.isStreaming        = false;
        this.isStartingStream   = false;
        this.isRestarting       = false;
        this.streamCreatedAt    = 0;
        this.audioBuffer        = [];   // audio queued during restart

        // Sentence state - cleared on every restart
        this.pendingText        = "";   // text from current stream only
        this.lastInterim        = "";
        this.sentenceTimer      = null;

        // Finalization gate
        this.isFinalizing       = false;
        this.lastFinalizeTime   = 0;

        // Bind STT callbacks
        this._onSTTData  = this._onSTTData.bind(this);
        this._onSTTError = this._onSTTError.bind(this);
    }

    // ─── Public: incoming WebSocket messages ──────────────────────────────────
    async handleMessage(msg) {
        switch (msg.event) {
            case "connected":
                this.roomId     = msg.roomId;
                this.userType   = msg.userType;
                this.myLanguage = msg.myLanguage;
                this.myName     = msg.myName || "User";
                console.log(`✅ [${this.userType}] connected – room:${this.roomId} lang:${this.myLanguage}`);
                this._registerConnection();
                this._notifyPartner("user_joined", { name: this.myName, language: this.myLanguage });
                // Pre-warm stream & API clients
                setTimeout(() => { if (!this.isStreaming) this._startStream(); }, 100);
                this._warmUpClients();
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

    // ─── Private: audio pipeline ──────────────────────────────────────────────

    _processAudio(base64Audio) {
        if (!this.myLanguage) return;
        const buffer = Buffer.from(base64Audio, "base64");

        // Queue during restart
        if (this.isRestarting) {
            this.audioBuffer.push(buffer);
            if (this.audioBuffer.length > 60) this.audioBuffer.shift();
            return;
        }

        // Start stream if needed
        if (!this.isStreaming && !this.isStartingStream) {
            this._startStream();
        }

        // Periodic safety restart (Google's 305s hard limit)
        if (Date.now() - this.streamCreatedAt > 240000) {
            console.log("🔄 Safety restart (4 min limit)");
            this._doRestart();
            return;
        }

        // Write audio
        if (this.recognizeStream && this.isStreaming) {
            try {
                this.recognizeStream.write(buffer);
            } catch (e) {
                console.error("Stream write error:", e.message);
                this._doRestart();
            }
        }
    }

    async _startStream() {
        if (this.isStreaming || this.isStartingStream) return;
        this.isStartingStream = true;

        // ⚠️ CRITICAL: Clear pending text from ANY previous stream.
        // This prevents old words from bleeding into new sentences.
        this.pendingText  = "";
        this.lastInterim  = "";

        const langCode = getSttLangCode(this.myLanguage);
        const isEnglish = getLangBase(this.myLanguage) === "en";

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({
                    config: {
                        encoding:                  "LINEAR16",
                        sampleRateHertz:           16000,
                        languageCode:              langCode,
                        enableAutomaticPunctuation: true,
                        useEnhanced:               true,
                        // latest_long for English, default for Indian scripts
                        model: isEnglish ? "latest_long" : "default",
                    },
                    interimResults: true,
                    singleUtterance: false,
                })
                .on("data",  this._onSTTData)
                .on("error", this._onSTTError)
                .on("end",   () => {
                    this.isStreaming     = false;
                    this.recognizeStream = null;
                    console.log(`🔴 Stream ended: ${langCode}`);
                });

            this.isStreaming      = true;
            this.isStartingStream = false;
            this.streamCreatedAt  = Date.now();
            console.log(`🎤 Stream started: ${langCode}`);

            // Replay buffered audio
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

    async _doRestart() {
        if (this.isRestarting) return;
        this.isRestarting = true;
        this._clearTimer();
        this._stopStream();
        await this._startStream();
        this.isRestarting = false;
    }

    // ─── STT callbacks ────────────────────────────────────────────────────────

    _onSTTData(response) {
        const result = response.results?.[0];
        if (!result) return;

        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        if (result.isFinal) {
            // Replace the pending text with ONLY this final result (no accumulation)
            this.pendingText = transcript;
            this.lastInterim = "";
            console.log(`📝 [${this.myLanguage}] FINAL: "${transcript}"`);
            // Finalize immediately and restart stream to clear Google's memory
            this._finalize("final");
        } else {
            // Show interim but don't accumulate it into pendingText yet
            if (this.lastInterim === transcript) return;
            this.lastInterim = transcript;
            this._sendToUI({ event: "transcript_interim", text: transcript });
            // Reset the silence timer
            this._resetTimer();
        }
    }

    _onSTTError(err) {
        const msg = err.message || "";
        const isNormal = msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11;
        if (!isNormal) console.error(`❌ STT Error [${this.myLanguage}]:`, msg);
        else console.log(`⏰ Stream timeout (normal) [${this.myLanguage}]`);

        this.isStreaming = false;
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }

        // Use best available text
        const best = this.pendingText || this.lastInterim;
        if (best) {
            this.pendingText = best;
            this._finalize("error-recovery");
        }
    }

    // ─── Timer ────────────────────────────────────────────────────────────────

    _resetTimer() {
        this._clearTimer();
        // 1s silence timeout for all languages
        this.sentenceTimer = setTimeout(() => this._finalize("timer"), 1000);
    }

    _clearTimer() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
            this.sentenceTimer = null;
        }
    }

    // ─── Finalize a sentence and send for translation ─────────────────────────

    _finalize(reason) {
        // Guard: only one finalization at a time
        if (this.isFinalizing) return;

        // Minimum gap between finalizations (prevents echo of same sentence)
        if (Date.now() - this.lastFinalizeTime < 400) {
            return;
        }

        const text = (this.pendingText || this.lastInterim || "").trim();
        if (!text) return;

        this.isFinalizing     = true;
        this.lastFinalizeTime = Date.now();
        this._clearTimer();

        // Capture and immediately clear state so next stream starts fresh
        const finalText   = text;
        this.pendingText  = "";
        this.lastInterim  = "";

        console.log(`\n🔵 [${this.myLanguage}] SENTENCE (${reason}): "${finalText}"\n`);

        // Send to translation pipeline (non-blocking)
        this._translateAndSend(finalText).catch(e => {
            console.error("Pipeline error:", e.message);
        });

        // Restart stream to clear Google's context — do it in background
        this._doRestart().finally(() => {
            this.isFinalizing = false;
        });
    }

    // ─── Translation + TTS Pipeline ───────────────────────────────────────────

    async _translateAndSend(text) {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;

        const partner = this.userType === "caller"
            ? session.receiverConnection
            : session.callerConnection;

        if (!partner?.myLanguage) {
            console.log("⚠️ Partner not connected, dropping sentence");
            return;
        }

        const t0 = Date.now();

        // 1. Translate
        const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
        console.log(`🌐 [${Date.now() - t0}ms] "${text}" → "${translated}"`);

        // 2. Send text immediately to BOTH sides
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

        // 3. Generate TTS and send audio (background, non-blocking)
        const ttsT0 = Date.now();
        this._tts(translated, partner.myLanguage).then(audio => {
            if (!audio) return;
            if (partner.ws?.readyState !== 1) return;

            // Check if Google already returned a WAV container
            const hasRiffHeader = audio.length >= 4 && audio.slice(0, 4).toString() === "RIFF";
            const wav = hasRiffHeader ? audio : buildWav(audio, TTS_SAMPLE_RATE);

            partner.ws.send(JSON.stringify({
                event:  "audio_playback",
                audio:  wav.toString("base64"),
                format: "wav",
            }));
            console.log(`🔊 TTS [${Date.now() - ttsT0}ms] → partner (${partner.myLanguage}). Pipeline total: ${Date.now() - t0}ms`);
        }).catch(e => console.error("TTS send error:", e.message));
    }

    // ─── Google API Helpers ───────────────────────────────────────────────────

    async _translate(text, from, to) {
        const fromBase = getLangBase(from);
        const toBase   = getLangBase(to);
        if (fromBase === toBase) return text;
        try {
            const [result] = await this.translateClient.translate(text, { from: fromBase, to: toBase });
            return result;
        } catch (e) {
            console.error("Translate API error:", e.message);
            return text; // fallback: show original
        }
    }

    async _tts(text, lang) {
        const voice = getTtsVoice(lang);
        try {
            const [res] = await this.ttsClient.synthesizeSpeech({
                input:       { text },
                voice,
                audioConfig: {
                    audioEncoding:  "LINEAR16",
                    sampleRateHertz: TTS_SAMPLE_RATE,
                    speakingRate:   1.1,
                },
            });
            return res.audioContent;
        } catch (e) {
            console.error(`TTS error [${lang}]:`, e.message);
            return null;
        }
    }

    async _warmUpClients() {
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
                console.log("🔥 API clients warmed up");
            } catch (_) { /* ignore warm-up errors */ }
        }, 300);
    }

    // ─── Room / Connection Helpers ────────────────────────────────────────────

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
        this._clearTimer();
        const leftover = (this.pendingText || this.lastInterim).trim();
        if (leftover) {
            this.pendingText = leftover;
            this._finalize("cleanup");
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
