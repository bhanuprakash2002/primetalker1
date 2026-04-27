// voice-processor.js - Production Live Translation (WebSocket, 16kHz PCM)
const speech     = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// ─── Credentials ──────────────────────────────────────────────────────────────
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    try { googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS); }
    catch (e) { console.error("Bad GOOGLE_CREDENTIALS:", e.message); }
}
const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};

// ─── Shared singleton clients (saves ~300ms auth on each connection) ──────────
const sharedSpeech    = new speech.SpeechClient(clientConfig);
const sharedTts       = new textToSpeech.TextToSpeechClient(clientConfig);
const sharedTranslate = new Translate(clientConfig);

// ─── STT language codes ───────────────────────────────────────────────────────
const STT_LANG = {
    en:"en-US", hi:"hi-IN", te:"te-IN", ta:"ta-IN", kn:"kn-IN",
    ml:"ml-IN", mr:"mr-IN", bn:"bn-IN", gu:"gu-IN", pa:"pa-IN", ur:"ur-IN",
    es:"es-ES", fr:"fr-FR", de:"de-DE", it:"it-IT", pt:"pt-BR",
    ar:"ar-XA", ja:"ja-JP", ko:"ko-KR", zh:"cmn-CN", ru:"ru-RU",
    nl:"nl-NL", pl:"pl-PL", tr:"tr-TR", vi:"vi-VN", th:"th-TH",
};

// ─── TTS voices ───────────────────────────────────────────────────────────────
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
    vi:  { languageCode:"vi-VN",  name:"vi-VN-Neural2-A" },
    th:  { languageCode:"th-TH",  name:"th-TH-Neural2-C" },
};

// Indian languages — don't use useEnhanced (not supported)
const INDIAN_LANGS = new Set(["hi","te","ta","kn","ml","mr","bn","gu","pa","ur"]);

const TTS_RATE = 24000; // WAV sample rate — must match this value in WAV header

function base(lang) { return (lang || "en").split("-")[0].toLowerCase(); }
function sttCode(lang) { return STT_LANG[base(lang)] || "en-US"; }

function buildWav(pcm, rate) {
    const h = Buffer.alloc(44);
    h.write("RIFF", 0);       h.writeUInt32LE(36 + pcm.length, 4);
    h.write("WAVE", 8);       h.write("fmt ", 12);
    h.writeUInt32LE(16, 16);  h.writeUInt16LE(1, 20);   // PCM
    h.writeUInt16LE(1, 22);   h.writeUInt32LE(rate, 24); // mono
    h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);  h.write("data", 36);
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

        // STT stream
        this.recognizeStream = null;
        this.isStreaming      = false;
        this.isRestarting     = false;
        this.streamCreatedAt  = 0;

        // Sentence accumulation (accumulate isFinal results, flush on silence)
        this.sentence      = "";   // accumulated isFinal text this turn
        this.lastInterim   = "";   // latest interim (backup if stream times out)
        this.lastSentence  = "";   // last text we actually translated
        this.sentenceTimer = null;
        this.SENTENCE_MS   = 1000; // 1s of silence after isFinal = send sentence

        // Pipeline lock — one translation at a time per speaker
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
                console.log(`✅ [${this.userType}] ${this.roomId} lang=${this.myLanguage}`);
                this._registerConnection();
                this._notifyPartner("user_joined", { name: this.myName, language: this.myLanguage });
                // Start stream immediately on connect
                this._startStream();
                // Warm up Translate + TTS
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
        const buffer = Buffer.from(base64Audio, "base64");

        // Restart if stream dead or approaching 4-min Google limit
        if (!this.isStreaming || !this.recognizeStream) {
            if (!this.isRestarting) this._restartStream();
            return;
        }
        if (Date.now() - this.streamCreatedAt > 240000) {
            this._restartStream();
            return;
        }

        try {
            this.recognizeStream.write(buffer);
        } catch (e) {
            console.error("Write error:", e.message);
            this._restartStream();
        }
    }

    // ── STT Stream ────────────────────────────────────────────────────────────
    async _startStream() {
        if (this.isStreaming || this.isRestarting) return;

        const lang      = base(this.myLanguage);
        const langCode  = sttCode(this.myLanguage);
        const isIndian  = INDIAN_LANGS.has(lang);
        const isEnglish = lang === "en";

        // Model selection:
        // English    → latest_long  (best accuracy for longer speech)
        // Indian     → latest_short (lower latency, supported for hi/te/ta etc)
        // Other      → latest_long
        const model = isEnglish ? "latest_long" : (isIndian ? "latest_short" : "latest_long");

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({
                    config: {
                        encoding:                   "LINEAR16",
                        sampleRateHertz:            16000,   // matches frontend AudioContext
                        languageCode:               langCode,
                        enableAutomaticPunctuation: false,   // OFF: avoids mid-sentence cuts
                        model,
                        // useEnhanced only for English/non-Indian — causes rejection for te-IN etc
                        ...(isIndian ? {} : { useEnhanced: true }),
                    },
                    interimResults:  true,
                    singleUtterance: false,
                })
                .on("data",  this._handleSTTData)
                .on("error", this._handleSTTError)
                .on("end",   () => {
                    this.isStreaming     = false;
                    this.recognizeStream = null;
                    console.log(`🔴 STT ended [${langCode}]`);
                });

            this.isStreaming     = true;
            this.streamCreatedAt = Date.now();
            console.log(`🎤 STT started [${langCode}] model=${model}`);
        } catch (e) {
            console.error("Failed to start STT:", e.message);
            this.isStreaming = false;
        }
    }

    async _restartStream() {
        if (this.isRestarting) return;
        this.isRestarting = true;
        try {
            if (this.recognizeStream) {
                try { this.recognizeStream.end(); } catch (_) {}
                this.recognizeStream = null;
            }
            this.isStreaming = false;
            await this._startStream();
        } finally {
            this.isRestarting = false;
        }
    }

    // ── STT Callbacks ─────────────────────────────────────────────────────────
    _handleSTTData(response) {
        const result = response.results?.[0];
        if (!result) return;
        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        if (result.isFinal) {
            // Accumulate final results — user may say multiple phrases before pausing
            this.sentence   = this.sentence ? `${this.sentence} ${transcript}` : transcript;
            this.lastInterim = "";
            console.log(`📝 Accumulated: "${this.sentence}"`);
        } else {
            // Show interim live; save as backup
            const preview   = this.sentence ? `${this.sentence} ${transcript}` : transcript;
            this.lastInterim = preview;
            this._sendToUI({ event: "transcript_interim", text: preview });
        }

        // Reset the 1s silence timer on every STT event
        this._resetSentenceTimer();
    }

    _handleSTTError(err) {
        const msg = err.message || "";
        const isNormal = msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11;
        if (!isNormal) console.error(`❌ STT Error [${this.myLanguage}]:`, msg);
        else           console.log(`⏰ STT timeout (normal) [${this.myLanguage}]`);

        this.isStreaming     = false;
        this.recognizeStream = null;

        // If stream timed out before isFinal, use interim as fallback
        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            console.log(`🔄 Using interim backup: "${this.lastInterim}"`);
            this.sentence = this.lastInterim;
        }
        this.lastInterim = "";

        // Finalize whatever we have
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
        if (!this.sentence || this.sentence === this.lastSentence) return;

        const text = this.sentence.trim();
        console.log(`\n🔵 SENTENCE: "${text}"\n`);
        this.lastSentence = text;
        this.sentence     = "";

        // Restart STT to clear Google's accumulated context for this stream
        setImmediate(() => this._restartStream());

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

            // 2. Send text to both UIs immediately
            const payload = {
                event: "translation", originalText: text, translatedText: translated,
                fromUser: this.userType, fromLanguage: this.myLanguage, toLanguage: partner.myLanguage,
            };
            this._sendToUI(payload);
            partner._sendToUI(payload);

            // 3. TTS in background — doesn't block next translation
            this._tts(translated, partner.myLanguage).then(audio => {
                if (!audio || partner.ws?.readyState !== 1) return;
                const wav = buildWav(audio, TTS_RATE);
                partner.ws.send(JSON.stringify({ event: "audio_playback", audio: wav.toString("base64"), format: "wav" }));
                console.log(`🔊 TTS done [${Date.now()-t0}ms total]`);
            }).catch(e => console.error("TTS bg error:", e.message));

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
            if (this.translateCache.size >= 100) this.translateCache.delete(this.translateCache.keys().next().value);
            this.translateCache.set(key, result);
            return result;
        } catch (e) {
            console.error("Translate error:", e.message);
            return text;
        }
    }

    async _tts(text, lang) {
        const b    = base(lang);
        const key  = `${text}|${b}`;
        if (this.ttsCache.has(key)) return this.ttsCache.get(key);

        const voice = TTS_VOICE[b] || { languageCode: STT_LANG[b] || "en-US", ssmlGender: "NEUTRAL" };
        const config = { audioEncoding: "LINEAR16", sampleRateHertz: TTS_RATE, speakingRate: 1.1 };

        try {
            const [res] = await this.ttsClient.synthesizeSpeech({ input: { text }, voice, audioConfig: config });
            if (this.ttsCache.size >= 50) this.ttsCache.delete(this.ttsCache.keys().next().value);
            this.ttsCache.set(key, res.audioContent);
            return res.audioContent;
        } catch (e) {
            console.error(`TTS error [${lang}]:`, e.message);
            // Fallback: neutral gender, no specific voice name
            try {
                const [fb] = await this.ttsClient.synthesizeSpeech({
                    input: { text },
                    voice: { languageCode: voice.languageCode, ssmlGender: "NEUTRAL" },
                    audioConfig: config,
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
                await Promise.all([
                    this.translateClient.translate("hello", { to: "en" }),
                    this.ttsClient.synthesizeSpeech({
                        input: { text: "." },
                        voice: { languageCode: "en-US" },
                        audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: TTS_RATE },
                    }),
                ]);
                console.log("🔥 APIs warmed");
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

        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (_) {}
            this.recognizeStream = null;
        }
        this.isStreaming = false;

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
