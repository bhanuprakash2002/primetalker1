// voice-processor.js — Continuous Stream, 48kHz, Perfect Translation
const speech       = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// ─── Google credentials ───────────────────────────────────────────────────────
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    try { googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); }
    catch (e) { console.error("Bad GOOGLE_CREDENTIALS:", e.message); }
}
const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};

// ─── Singleton clients — created once per process (saves ~300ms per connection)
const sharedSpeech    = new speech.SpeechClient(clientConfig);
const sharedTts       = new textToSpeech.TextToSpeechClient(clientConfig);
const sharedTranslate = new Translate(clientConfig);

// ─── Language tables ──────────────────────────────────────────────────────────
const STT_LANG_MAP = {
    en:"en-US", hi:"hi-IN", te:"te-IN", ta:"ta-IN", kn:"kn-IN",
    ml:"ml-IN", mr:"mr-IN", bn:"bn-IN", gu:"gu-IN", pa:"pa-IN", ur:"ur-IN",
    es:"es-ES", fr:"fr-FR", de:"de-DE", it:"it-IT", pt:"pt-BR",
    ar:"ar-XA", ja:"ja-JP", ko:"ko-KR", zh:"cmn-CN", ru:"ru-RU",
    nl:"nl-NL", pl:"pl-PL", tr:"tr-TR", vi:"vi-VN", th:"th-TH",
};

const TTS_VOICE_MAP = {
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
    vi:  { languageCode:"vi-VN",  name:"vi-VN-Neural2-A" },
    th:  { languageCode:"th-TH",  name:"th-TH-Neural2-C" },
};

// STT model per language:
// - Only specify models we KNOW work for that language
// - Leave undefined → Google uses its default (always safe)
const STT_MODEL_MAP = {
    en: "latest_long",   // best for English dictation
    hi: "latest_short",  // confirmed supported for hi-IN, lower latency
    es: "latest_long", fr: "latest_long", de: "latest_long",
    pt: "latest_long", ja: "latest_long", ko: "latest_long",
    zh: "latest_long", ru: "latest_long",
    // te, ta, kn, ml, mr, bn, gu, pa → undefined → Google default (safe)
};

// Languages that support useEnhanced (Indian script langs don't)
const ENHANCED_LANGS = new Set(["en","es","fr","de","pt","it","ru","zh","ja","ko","nl","pl","tr","vi","th","ar"]);

const SAMPLE_RATE = 48000; // 48kHz: matches browser native output

function langBase(lang) { return (lang || "en").split("-")[0].toLowerCase(); }

function sttLangCode(lang) {
    return STT_LANG_MAP[langBase(lang)] || "en-US";
}

function buildWav(pcm, rate) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);           h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVE", 8);           h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);      h.writeUInt16LE(1, 20);  // PCM
    h.writeUInt16LE(1, 22);       h.writeUInt32LE(rate, 24); // mono
    h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);      h.write("data", 36);
    h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

// ─── VoiceProcessor ───────────────────────────────────────────────────────────
class VoiceProcessor {
    constructor(ws, activeSessions) {
        this.ws             = ws;
        this.activeSessions = activeSessions;

        // Shared clients
        this.speechClient    = sharedSpeech;
        this.ttsClient       = sharedTts;
        this.translateClient = sharedTranslate;

        // Identity
        this.roomId     = null;
        this.userType   = null;
        this.myLanguage = null;
        this.myName     = null;

        // Continuous STT stream state
        this.recognizeStream  = null;
        this.isStreaming       = false;
        this.isStartingStream  = false;   // true while Google stream is being created
        this.streamCreatedAt   = 0;
        this.audioBuffer       = [];      // buffers audio during startup gap

        // Sentence accumulation (isFinal events → sentence → translate)
        this.sentence      = "";   // accumulated isFinal text
        this.lastInterim   = "";   // latest interim (fallback if stream times out)
        this.lastSentence  = "";   // last translated sentence (dedup guard)
        this.sentenceTimer = null;
        this.SENTENCE_MS   = 900;  // ms after last speech → finalize

        // Translation pipeline
        this.isProcessing  = false;   // one translation at a time per speaker

        // Caches
        this.translateCache = new Map(); // "text|from|to" → translated
        this.ttsCache       = new Map(); // "text|lang"    → audioBuffer

        // Bind STT callbacks
        this._onData  = this._onData.bind(this);
        this._onError = this._onError.bind(this);
    }

    // ── Entry point ───────────────────────────────────────────────────────────
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

                // Start stream immediately + warm up with silence so model loads before first word
                this._startStream().then(() => this._sendWarmupSilence());
                this._warmUpAPIs();
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

    // ── Audio pipeline ────────────────────────────────────────────────────────
    _processAudio(base64Audio) {
        if (!this.myLanguage) return;
        const buf = Buffer.from(base64Audio, "base64");

        // Stream not ready yet → buffer so no audio is lost
        if (this.isStartingStream || !this.isStreaming || !this.recognizeStream) {
            this.audioBuffer.push(buf);
            if (this.audioBuffer.length > 150) this.audioBuffer.shift(); // ~15s cap
            return;
        }

        // CONTINUOUS STREAM: only restart at Google's 4-minute hard limit
        // No per-sentence restarts → zero startup delay between sentences
        if (Date.now() - this.streamCreatedAt > 230000) { // 3m50s
            console.log("🔄 4-min safety restart");
            this._restartStream();
            return;
        }

        // Write directly to live stream
        try {
            this.recognizeStream.write(buf);
        } catch (e) {
            console.error("Write error:", e.message);
            this._restartStream();
        }
    }

    // ── STT stream ────────────────────────────────────────────────────────────
    async _startStream() {
        if (this.isStreaming || this.isStartingStream) return;
        this.isStartingStream = true;

        const lang     = langBase(this.myLanguage);
        const langCode = sttLangCode(this.myLanguage);
        const model    = STT_MODEL_MAP[lang];           // undefined = Google default
        const enhanced = ENHANCED_LANGS.has(lang);

        const config = {
            encoding:                   "LINEAR16",
            sampleRateHertz:            SAMPLE_RATE,
            languageCode:               langCode,
            enableAutomaticPunctuation: false,
            ...(model    ? { model }            : {}),
            ...(enhanced ? { useEnhanced: true } : {}),
        };

        console.log(`🎤 STT start [${langCode}] model=${model||"default"} enhanced=${enhanced}`);

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({ config, interimResults: true, singleUtterance: false })
                .on("data",  this._onData)
                .on("error", this._onError)
                .on("end",   () => {
                    this.isStreaming     = false;
                    this.recognizeStream = null;
                    console.log(`🔴 STT ended [${langCode}]`);
                    // Auto-restart if unexpected end (e.g. network blip)
                    // Don't restart if we intentionally stopped (cleanup sets myLanguage null)
                    if (this.myLanguage) setTimeout(() => this._restartStream(), 500);
                });

            this.isStreaming      = true;
            this.isStartingStream = false;
            this.streamCreatedAt  = Date.now();
            console.log(`✅ STT live [${langCode}]`);

            // Replay audio buffered during startup
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

    async _restartStream() {
        if (this.isStartingStream) return;
        console.log(`🔄 Restarting STT [${this.myLanguage}]`);
        this.isStreaming = false;
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }
        await this._startStream();
    }

    // Send 200ms of silence so Google pre-loads the recognition model
    _sendWarmupSilence() {
        if (!this.recognizeStream || !this.isStreaming) return;
        // 200ms @ 48kHz, 16-bit mono = 48000 * 0.2 * 2 bytes = 19200 bytes
        const silence = Buffer.alloc(19200, 0);
        try {
            this.recognizeStream.write(silence);
            console.log(`🔥 Warmup silence sent [${this.myLanguage}]`);
        } catch (_) {}
    }

    // ── STT callbacks ─────────────────────────────────────────────────────────
    _onData(response) {
        const result = response.results?.[0];
        if (!result) return;
        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        if (result.isFinal) {
            // Accumulate confirmed text — user may say multiple phrases before pausing
            this.sentence    = this.sentence ? `${this.sentence} ${transcript}` : transcript;
            this.lastInterim = "";
            console.log(`📝 Final: "${transcript}" | Buffer: "${this.sentence}"`);
        } else {
            // Live interim — show immediately
            const preview    = this.sentence ? `${this.sentence} ${transcript}` : transcript;
            this.lastInterim = preview;
            this._sendToUI({ event: "transcript_interim", text: preview });
        }

        // Reset 900ms silence timer on every STT event
        this._resetTimer();
    }

    _onError(err) {
        const msg      = err?.message || "";
        const isNormal = msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11;
        if (!isNormal) console.error(`❌ STT Error [${this.myLanguage}]:`, msg);
        else           console.log(`⏰ STT normal timeout [${this.myLanguage}]`);

        this.isStreaming     = false;
        this.recognizeStream = null;

        // Fallback: if no finals yet, use last interim
        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            this.sentence = this.lastInterim;
            console.log(`🔄 Using interim: "${this.sentence}"`);
        }
        this.lastInterim = "";

        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalize();
        }

        // Always restart after error
        if (this.myLanguage) setTimeout(() => this._restartStream(), 500);
    }

    // ── Sentence timer ────────────────────────────────────────────────────────
    _resetTimer() {
        if (this.sentenceTimer) clearTimeout(this.sentenceTimer);
        this.sentenceTimer = setTimeout(() => this._finalize(), this.SENTENCE_MS);
    }

    _finalize() {
        if (this.sentenceTimer) { clearTimeout(this.sentenceTimer); this.sentenceTimer = null; }

        const text = this.sentence.trim();
        if (!text || text === this.lastSentence) {
            this.sentence = "";
            return;
        }

        console.log(`\n🔵 SENTENCE [${this.myLanguage}]: "${text}"\n`);
        this.lastSentence = text;
        this.sentence     = "";

        // Translate (no stream restart needed — continuous stream stays alive)
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
            if (!partner?.myLanguage) { console.log("⚠️ Partner not connected"); return; }

            // 1. Translate
            const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
            console.log(`🌐 [${Date.now()-t0}ms] "${text}" → "${translated}"`);

            // 2. Send text to both UIs immediately (before TTS is ready)
            const payload = {
                event: "translation", originalText: text, translatedText: translated,
                fromUser: this.userType, fromLanguage: this.myLanguage, toLanguage: partner.myLanguage,
            };
            this._sendToUI(payload);
            partner._sendToUI(payload);

            // 3. Generate and send TTS audio (non-blocking)
            this._tts(translated, partner.myLanguage).then(audio => {
                if (!audio || partner.ws?.readyState !== 1) return;
                const wav = buildWav(audio, SAMPLE_RATE);
                partner.ws.send(JSON.stringify({
                    event: "audio_playback",
                    audio: wav.toString("base64"),
                    format: "wav",
                }));
                console.log(`🔊 TTS done [${Date.now()-t0}ms total]`);
            }).catch(e => console.error("TTS error:", e.message));

        } catch (e) {
            console.error("translateAndSpeak error:", e.message);
        } finally {
            this.isProcessing = false;
        }
    }

    async _translate(text, from, to) {
        const f = langBase(from), t = langBase(to);
        if (f === t) return text;
        const key = `${text}|${f}|${t}`;
        if (this.translateCache.has(key)) return this.translateCache.get(key);
        try {
            const [result] = await this.translateClient.translate(text, { from: f, to: t });
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
        const b   = langBase(lang);
        const key = `${text}|${b}`;
        if (this.ttsCache.has(key)) return this.ttsCache.get(key);

        const voice = TTS_VOICE_MAP[b] || { languageCode: STT_LANG_MAP[b] || "en-US", ssmlGender: "NEUTRAL" };
        const cfg   = { audioEncoding: "LINEAR16", sampleRateHertz: SAMPLE_RATE, speakingRate: 1.1 };

        try {
            const [res] = await this.ttsClient.synthesizeSpeech({ input: { text }, voice, audioConfig: cfg });
            if (this.ttsCache.size >= 50)
                this.ttsCache.delete(this.ttsCache.keys().next().value);
            this.ttsCache.set(key, res.audioContent);
            return res.audioContent;
        } catch (e) {
            console.error(`TTS error [${lang}]:`, e.message);
            // Fallback: neutral gender, no specific voice name
            try {
                const [fb] = await this.ttsClient.synthesizeSpeech({
                    input: { text },
                    voice: { languageCode: voice.languageCode, ssmlGender: "NEUTRAL" },
                    audioConfig: cfg,
                });
                return fb.audioContent;
            } catch (_) { return null; }
        }
    }

    async _warmUpAPIs() {
        setTimeout(async () => {
            try {
                await this.translateClient.translate("hello", { to: "en" });
                console.log("🔥 Translate API warmed");
            } catch (_) {}
        }, 300);
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
        if (this.sentence && this.sentence !== this.lastSentence) this._finalize();

        // Signal auto-restart to stop
        const lang = this.myLanguage;
        this.myLanguage = null;

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
        console.log(`🧹 Cleanup: ${this.userType} [${lang}] in ${this.roomId}`);
    }
}

module.exports = VoiceProcessor;
