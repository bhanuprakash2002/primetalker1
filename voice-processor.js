// voice-processor.js - Production Live Translation (WebSocket, 16kHz PCM)
const speech       = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// ─── Credentials ──────────────────────────────────────────────────────────────
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    try { googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); }
    catch (e) { console.error("Bad GOOGLE_CREDENTIALS:", e.message); }
}
const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};

// ─── Shared singleton clients ─────────────────────────────────────────────────
const sharedSpeech    = new speech.SpeechClient(clientConfig);
const sharedTts       = new textToSpeech.TextToSpeechClient(clientConfig);
const sharedTranslate = new Translate(clientConfig);

// ─── Language maps ────────────────────────────────────────────────────────────
const STT_LANG = {
    en:"en-US", hi:"hi-IN", te:"te-IN", ta:"ta-IN", kn:"kn-IN",
    ml:"ml-IN", mr:"mr-IN", bn:"bn-IN", gu:"gu-IN", pa:"pa-IN", ur:"ur-IN",
    es:"es-ES", fr:"fr-FR", de:"de-DE", it:"it-IT", pt:"pt-BR",
    ar:"ar-XA", ja:"ja-JP", ko:"ko-KR", zh:"cmn-CN", ru:"ru-RU",
    nl:"nl-NL", pl:"pl-PL", tr:"tr-TR", vi:"vi-VN", th:"th-TH",
};

const TTS_VOICE = {
    en:  { languageCode:"en-US",  name:"en-US-Neural2-J" },
    hi:  { languageCode:"hi-IN",  name:"hi-IN-Neural2-A" },
    te:  { languageCode:"te-IN",  name:"te-IN-Standard-A" },
    ta:  { languageCode:"ta-IN",  name:"ta-IN-Standard-A" },
    kn:  { languageCode:"kn-IN",  name:"kn-IN-Standard-A" },
    ml:  { languageCode:"ml-IN",  name:"ml-IN-Standard-A" },
    mr:  { languageCode:"mr-IN",  name:"mr-IN-Standard-A" },
    bn:  { languageCode:"bn-IN",  name:"bn-IN-Standard-A" },
    gu:  { languageCode:"gu-IN",  name:"gu-IN-Standard-A" },
    pa:  { languageCode:"pa-IN",  name:"pa-IN-Standard-A" },
    es:  { languageCode:"es-ES",  name:"es-ES-Neural2-A" },
    fr:  { languageCode:"fr-FR",  name:"fr-FR-Neural2-A" },
    de:  { languageCode:"de-DE",  name:"de-DE-Neural2-A" },
    pt:  { languageCode:"pt-BR",  name:"pt-BR-Neural2-A" },
    it:  { languageCode:"it-IT",  name:"it-IT-Neural2-A" },
    ru:  { languageCode:"ru-RU",  name:"ru-RU-Standard-A" },
    zh:  { languageCode:"cmn-CN", name:"cmn-CN-Standard-A" },
    ja:  { languageCode:"ja-JP",  name:"ja-JP-Neural2-B" },
    ko:  { languageCode:"ko-KR",  name:"ko-KR-Neural2-A" },
    ar:  { languageCode:"ar-XA",  name:"ar-XA-Standard-A" },
    tr:  { languageCode:"tr-TR",  name:"tr-TR-Neural2-A" },
    nl:  { languageCode:"nl-NL",  name:"nl-NL-Neural2-A" },
    pl:  { languageCode:"pl-PL",  name:"pl-PL-Neural2-A" },
};

// Models confirmed to work per language:
// - en: latest_long (best accuracy for dictation)
// - hi: latest_short (supported, lower latency)
// - te/ta/kn/ml etc: NO model specified — only "default" is supported
const STT_MODEL = {
    en: "latest_long",
    hi: "latest_short",
    es: "latest_long", fr: "latest_long", de: "latest_long",
    pt: "latest_long", ja: "latest_long", ko: "latest_long",
    zh: "latest_long", ru: "latest_long",
};

// Languages where useEnhanced is NOT supported (Indian scripts)
const NO_ENHANCED = new Set(["te","ta","kn","ml","mr","bn","gu","pa","ur"]);

const TTS_RATE = 24000;

function base(lang) { return (lang || "en").split("-")[0].toLowerCase(); }

function buildWav(pcm, rate) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);          h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVE", 8);          h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);     h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);      h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);     h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

// ─── VoiceProcessor ───────────────────────────────────────────────────────────
class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws             = websocket;
        this.activeSessions = activeSessions;

        this.speechClient    = sharedSpeech;
        this.ttsClient       = sharedTts;
        this.translateClient = sharedTranslate;

        // Identity
        this.roomId     = null;
        this.userType   = null;
        this.myLanguage = null;
        this.myName     = null;

        // STT stream state
        this.recognizeStream = null;
        this.isStreaming      = false;  // true only when stream is live and writable
        this.isStartingStream = false;  // true during async stream creation
        this.streamCreatedAt  = 0;
        this.audioBuffer      = [];     // holds audio during stream restart gap

        // Sentence accumulation
        this.sentence      = "";   // accumulated isFinal text this turn
        this.lastInterim   = "";   // latest interim (fallback if stream times out)
        this.lastSentence  = "";   // last text we actually translated (dedup guard)
        this.sentenceTimer = null;
        this.SENTENCE_MS   = 1000; // ms of silence → finalize sentence

        // Pipeline lock
        this.isProcessing = false;

        // Caches
        this.translateCache = new Map();
        this.ttsCache       = new Map();

        this._handleSTTData  = this._handleSTTData.bind(this);
        this._handleSTTError = this._handleSTTError.bind(this);
    }

    // ── Public entry point ────────────────────────────────────────────────────
    async handleMessage(msg) {
        switch (msg.event) {
            case "connected":
                this.roomId     = msg.roomId;
                this.userType   = msg.userType;
                this.myLanguage = msg.myLanguage;
                this.myName     = msg.myName || "User";
                console.log(`✅ [${this.userType}] room=${this.roomId} lang=${this.myLanguage}`);
                this._registerConnection();
                this._notifyPartner("user_joined", { name: this.myName, language: this.myLanguage });
                await this._startStream();   // start immediately on connect
                this._warmUp();
                break;

            case "audio":
                this._processAudio(msg.audio);
                break;

            case "disconnect":
            case "stop":
                await this.cleanup();
                break;
        }
    }

    // ── Audio → Google STT ────────────────────────────────────────────────────
    _processAudio(base64Audio) {
        if (!this.myLanguage) return;
        const buf = Buffer.from(base64Audio, "base64");

        // If stream is not ready yet, buffer audio so nothing is lost
        if (this.isStartingStream || !this.isStreaming || !this.recognizeStream) {
            this.audioBuffer.push(buf);
            if (this.audioBuffer.length > 100) this.audioBuffer.shift(); // cap at ~10s
            return;
        }

        // Safety: restart after 4 minutes (Google hard limit)
        if (Date.now() - this.streamCreatedAt > 240000) {
            console.log("🔄 4-min limit restart");
            this._doRestart();
            return;
        }

        // Write to live stream
        try {
            this.recognizeStream.write(buf);
        } catch (e) {
            console.error("Write error:", e.message);
            this._doRestart();
        }
    }

    // ── Stream lifecycle ──────────────────────────────────────────────────────
    // _startStream: creates a NEW stream. Caller must ensure no stream is running.
    async _startStream() {
        if (this.isStreaming || this.isStartingStream) return;
        this.isStartingStream = true;

        // Reset sentence state for new stream
        this.sentence    = "";
        this.lastInterim = "";
        this.lastSpeechTime = Date.now();

        const lang     = base(this.myLanguage);
        const langCode = STT_LANG[lang] || "en-US";
        const model    = STT_MODEL[lang];  // undefined for Indian langs (uses default)
        const enhanced = !NO_ENHANCED.has(lang);

        const config = {
            encoding:                   "LINEAR16",
            sampleRateHertz:            16000,
            languageCode:               langCode,
            enableAutomaticPunctuation: false,
            ...(model    ? { model }           : {}),
            ...(enhanced ? { useEnhanced: true } : {}),
        };

        console.log(`🎤 Starting STT [${langCode}] model=${model||"default"} enhanced=${enhanced}`);

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({ config, interimResults: true, singleUtterance: false })
                .on("data",  this._handleSTTData)
                .on("error", this._handleSTTError)
                .on("end",   () => {
                    this.isStreaming     = false;
                    this.recognizeStream = null;
                    console.log(`🔴 STT ended [${langCode}]`);
                });

            this.isStreaming      = true;
            this.isStartingStream = false;
            this.streamCreatedAt  = Date.now();
            console.log(`✅ STT live [${langCode}]`);

            // Replay audio buffered during restart
            if (this.audioBuffer.length > 0) {
                const chunks = this.audioBuffer.splice(0);
                chunks.forEach(c => { try { this.recognizeStream.write(c); } catch (_) {} });
                console.log(`📡 Replayed ${chunks.length} buffered chunks`);
            }
        } catch (e) {
            console.error("STT start failed:", e.message);
            this.isStreaming      = false;
            this.isStartingStream = false;
        }
    }

    // _doRestart: gracefully stop then restart stream
    // NOTE: does NOT set isRestarting — that was the bug causing _startStream to be skipped
    async _doRestart() {
        if (this.isStartingStream) return; // already starting
        this.isStreaming = false;
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }
        await this._startStream();
    }

    // ── STT Callbacks ─────────────────────────────────────────────────────────
    _handleSTTData(response) {
        const result = response.results?.[0];
        if (!result) return;
        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        if (result.isFinal) {
            // Accumulate finals — user may say multiple phrases before pausing
            this.sentence    = this.sentence ? `${this.sentence} ${transcript}` : transcript;
            this.lastInterim = "";
            console.log(`📝 Final: "${transcript}" | Accumulated: "${this.sentence}"`);
        } else {
            // Show live interim
            const preview    = this.sentence ? `${this.sentence} ${transcript}` : transcript;
            this.lastInterim = preview;
            this._sendToUI({ event: "transcript_interim", text: preview });
        }

        // Reset silence timer on every STT event
        this._resetSentenceTimer();
    }

    _handleSTTError(err) {
        const msg      = err.message || "";
        const isNormal = msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11;
        if (!isNormal) console.error(`❌ STT Error [${this.myLanguage}]:`, msg);
        else           console.log(`⏰ STT timeout (normal) [${this.myLanguage}]`);

        this.isStreaming     = false;
        this.recognizeStream = null;

        // Use interim as fallback if no finals accumulated
        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            console.log(`🔄 Interim fallback: "${this.lastInterim}"`);
            this.sentence = this.lastInterim;
        }
        this.lastInterim = "";

        // Finalize what we have
        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalizeSentence();
        }
    }

    // ── Sentence Timer ────────────────────────────────────────────────────────
    _resetSentenceTimer() {
        if (this.sentenceTimer) clearTimeout(this.sentenceTimer);
        this.sentenceTimer = setTimeout(() => this._finalizeSentence(), this.SENTENCE_MS);
    }

    _finalizeSentence() {
        if (this.sentenceTimer) { clearTimeout(this.sentenceTimer); this.sentenceTimer = null; }
        if (!this.sentence || this.sentence === this.lastSentence) {
            this.sentence = "";
            return;
        }

        const text = this.sentence.trim();
        console.log(`\n🔵 SENTENCE [${this.myLanguage}]: "${text}"\n`);
        this.lastSentence = text;
        this.sentence     = "";

        // Restart stream to clear Google's context for next sentence
        setImmediate(() => this._doRestart());

        // Translate and play TTS
        this._translateAndSpeak(text);
    }

    // ── Translation + TTS ─────────────────────────────────────────────────────
    async _translateAndSpeak(text) {
        if (this.isProcessing || !text) return;
        this.isProcessing = true;
        const t0 = Date.now();

        try {
            const session = this.activeSessions.get(this.roomId);
            if (!session) return;

            const partner = this.userType === "caller"
                ? session.receiverConnection
                : session.callerConnection;

            if (!partner?.myLanguage) {
                console.log("⚠️ Partner not connected, dropping:", text);
                return;
            }

            // 1. Translate
            const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
            console.log(`🌐 [${Date.now()-t0}ms] "${text}" → "${translated}"`);

            // 2. Send text to both UIs immediately (don't wait for TTS)
            const payload = {
                event: "translation", originalText: text, translatedText: translated,
                fromUser: this.userType, fromLanguage: this.myLanguage, toLanguage: partner.myLanguage,
            };
            this._sendToUI(payload);
            partner._sendToUI(payload);

            // 3. TTS in background — won't block next sentence translation
            this._tts(translated, partner.myLanguage).then(audio => {
                if (!audio || partner.ws?.readyState !== 1) return;
                const wav = buildWav(audio, TTS_RATE);
                partner.ws.send(JSON.stringify({
                    event: "audio_playback",
                    audio: wav.toString("base64"),
                    format: "wav",
                }));
                console.log(`🔊 TTS [${Date.now()-t0}ms total]`);
            }).catch(e => console.error("TTS error:", e.message));

        } catch (e) {
            console.error("translateAndSpeak error:", e.message);
        } finally {
            this.isProcessing = false;
        }
    }

    async _translate(text, from, to) {
        const f = base(from), t2 = base(to);
        if (f === t2) return text;
        const key = `${text}|${f}|${t2}`;
        if (this.translateCache.has(key)) return this.translateCache.get(key);
        try {
            const [result] = await this.translateClient.translate(text, { from: f, to: t2 });
            if (this.translateCache.size >= 100)
                this.translateCache.delete(this.translateCache.keys().next().value);
            this.translateCache.set(key, result);
            return result;
        } catch (e) {
            console.error("Translate error:", e.message);
            return text;
        }
    }

    async _tts(text, lang) {
        const b   = base(lang);
        const key = `${text}|${b}`;
        if (this.ttsCache.has(key)) return this.ttsCache.get(key);

        const voice = TTS_VOICE[b] || { languageCode: STT_LANG[b] || "en-US", ssmlGender: "NEUTRAL" };
        const cfg   = { audioEncoding: "LINEAR16", sampleRateHertz: TTS_RATE, speakingRate: 1.1 };

        try {
            const [res] = await this.ttsClient.synthesizeSpeech({ input: { text }, voice, audioConfig: cfg });
            if (this.ttsCache.size >= 50)
                this.ttsCache.delete(this.ttsCache.keys().next().value);
            this.ttsCache.set(key, res.audioContent);
            return res.audioContent;
        } catch (e) {
            console.error(`TTS error [${lang}]:`, e.message);
            // Fallback: neutral gender (no specific voice name)
            try {
                const [fb] = await this.ttsClient.synthesizeSpeech({
                    input: { text },
                    voice: { languageCode: voice.languageCode, ssmlGender: "NEUTRAL" },
                    audioConfig: cfg,
                });
                return fb.audioContent;
            } catch (e2) {
                console.error("TTS fallback error:", e2.message);
                return null;
            }
        }
    }

    async _warmUp() {
        setTimeout(async () => {
            try {
                await this.translateClient.translate("hello", { to: "en" });
                console.log("🔥 Translate warmed");
            } catch (_) {}
        }, 500);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    _registerConnection() {
        const s = this.activeSessions.get(this.roomId);
        if (!s) return;
        if (this.userType === "caller") s.callerConnection   = this;
        else                            s.receiverConnection = this;
    }

    _sendToUI(data) {
        try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(data)); } catch (_) {}
    }

    _notifyPartner(event, data) {
        const s = this.activeSessions.get(this.roomId);
        if (!s) return;
        const p = this.userType === "caller" ? s.receiverConnection : s.callerConnection;
        if (p?.ws?.readyState === 1) p.ws.send(JSON.stringify({ event, ...data }));
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    async cleanup() {
        if (this.sentenceTimer) { clearTimeout(this.sentenceTimer); this.sentenceTimer = null; }
        if (this.sentence && this.sentence !== this.lastSentence) this._finalizeSentence();

        this.isStreaming      = false;
        this.isStartingStream = false;
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }

        const s = this.activeSessions.get(this.roomId);
        if (s) {
            if (s.callerConnection   === this) s.callerConnection   = null;
            if (s.receiverConnection === this) s.receiverConnection = null;
        }
        this._notifyPartner("user_left", {});
        console.log(`🧹 Cleanup: ${this.userType} in ${this.roomId}`);
    }
}

module.exports = VoiceProcessor;
