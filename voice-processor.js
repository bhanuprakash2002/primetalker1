// voice-processor.js - Robust Live Translation with Sentence Accumulation
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
}

class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws = websocket;
        this.activeSessions = activeSessions;

        const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};
        this.speechClient = new speech.SpeechClient(clientConfig);
        this.ttsClient = new textToSpeech.TextToSpeechClient(clientConfig);
        this.translateClient = new Translate(googleCredentials ? { credentials: googleCredentials } : {});

        this.roomId = null;
        this.userType = null;
        this.myLanguage = null;
        this.myName = null;

        this.recognizeStream = null;
        this.isStreaming = false;
        this.isStartingStream = false; // FIX: prevents parallel _startStream calls
        this.streamCreatedAt = 0;
        this.audioBuffer = [];         // FIX: buffer audio during startup gap

        this.sentence = "";
        this.lastInterim = "";
        this.lastSentence = "";
        this.sentenceTimer = null;
        this.SENTENCE_TIMEOUT = 1000;

        this.isProcessing = false;

        this.translationCache = new Map();
        this.ttsCache = new Map();
        this.MAX_TRANSLATION_CACHE = 100;
        this.MAX_TTS_CACHE = 50;

        this._handleSTTData = this._handleSTTData.bind(this);
        this._handleSTTError = this._handleSTTError.bind(this);
    }

    async handleMessage(msg) {
        switch (msg.event) {
            case "connected":
                this.roomId = msg.roomId;
                this.userType = msg.userType;
                this.myLanguage = msg.myLanguage;
                this.myName = msg.myName || "User";
                console.log(`✅ ${this.userType} connected in ${this.roomId} (${this.myLanguage})`);
                this._registerConnection();
                this._notifyPartner("user_joined", { name: this.myName, language: this.myLanguage });
                if (!this.isStreaming && !this.isStartingStream) {
                    console.log(`🔥 Pre-warming STT for ${this.myLanguage}...`);
                    this._startStream().then(() => {
                        if (this.recognizeStream) {
                            const silence = Buffer.alloc(9600);
                            try { this.recognizeStream.write(silence); } catch (e) {}
                            console.log(`🔥 Warmup sent for ${this.myLanguage}`);
                        }
                    });
                }
                break;
            case "audio":
                await this._processAudio(msg.audio);
                break;
            case "disconnect":
            case "stop":
                await this.cleanup();
                break;
        }
    }

    _registerConnection() {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        if (this.userType === "caller") session.callerConnection = this;
        else session.receiverConnection = this;
    }

    async _processAudio(base64Audio) {
        if (!this.myLanguage) return;
        const buffer = Buffer.from(base64Audio, "base64");

        // FIX: buffer audio while stream is being created so no words are lost
        if (this.isStartingStream) {
            this.audioBuffer.push(buffer);
            if (this.audioBuffer.length > 150) this.audioBuffer.shift();
            return;
        }

        if (!this.isStreaming) {
            await this._startStream();
        }

        const streamAge = Date.now() - this.streamCreatedAt;
        if (streamAge > 50000) {
            console.log("🔄 Restarting stream (age limit)");
            await this._restartStream();
        }

        if (this.recognizeStream) {
            try {
                this.recognizeStream.write(buffer);
            } catch (e) {
                console.error("Write error:", e.message);
                await this._restartStream();
            }
        }
    }

    async _startStream() {
        if (this.isStreaming || this.isStartingStream) return;
        this.isStartingStream = true;

        const langCode = this._getLangCode(this.myLanguage);
        const indianCodes = ["hi-IN", "te-IN", "ta-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN"];
        const model = indianCodes.includes(langCode) ? "latest_short" : "latest_long";

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({
                    config: {
                        encoding: "LINEAR16",
                        sampleRateHertz: 48000,
                        languageCode: langCode,
                        enableAutomaticPunctuation: true,
                        model: model,
                        useEnhanced: true
                    },
                    interimResults: true,
                    singleUtterance: false
                })
                .on("data", this._handleSTTData)
                .on("error", this._handleSTTError)
                .on("end", () => {
                    this.isStreaming = false;
                    this.recognizeStream = null;
                });

            this.isStreaming = true;
            this.isStartingStream = false;
            this.streamCreatedAt = Date.now();
            console.log(`🎤 Stream started: ${langCode} (model: ${model})`);

            // FIX: replay audio buffered during startup
            if (this.audioBuffer.length > 0) {
                const chunks = this.audioBuffer.splice(0);
                chunks.forEach(c => { try { this.recognizeStream.write(c); } catch (_) {} });
                console.log(`📡 Replayed ${chunks.length} buffered chunks`);
            }
        } catch (e) {
            console.error("Failed to start stream:", e.message);
            this.isStreaming = false;
            this.isStartingStream = false;
        }
    }

    async _stopStream() {
        if (this.recognizeStream) {
            try { this.recognizeStream.end(); } catch (e) {}
        }
        this.recognizeStream = null;
        this.isStreaming = false;
        this.isStartingStream = false;
    }

    async _restartStream() {
        const savedSentence = this.sentence;
        await this._stopStream();
        this.sentence = savedSentence;
        await this._startStream();
    }

    _handleSTTData(response) {
        if (!response.results?.[0]) return;
        const result = response.results[0];
        const transcript = result.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;

        if (result.isFinal) {
            this.sentence = this.sentence ? this.sentence + " " + transcript : transcript;
            this.lastInterim = "";
            console.log(`📝 Accumulated: "${this.sentence}"`);
        } else {
            const preview = this.sentence ? this.sentence + " " + transcript : transcript;
            this.lastInterim = preview;
            console.log(`⏳ Speaking: "${preview}"`);
            this._sendToUI({ event: "transcript_interim", text: preview });
        }

        this._resetSentenceTimer();
    }

    _handleSTTError(err) {
        const msg = err.message || "";
        if (msg.includes("Audio Timeout") || msg.includes("OUT_OF_RANGE") || err.code === 11) {
            console.log("⏰ Stream timeout (normal)");
        } else {
            console.error("❌ STT Error:", msg);
        }

        this.isStreaming = false;
        this.recognizeStream = null;

        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            console.log(`🔄 Using interim backup: "${this.lastInterim}"`);
            this.sentence = this.lastInterim;
        }

        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalizeSentence();
        }

        this.lastInterim = "";
    }

    _resetSentenceTimer() {
        if (this.sentenceTimer) clearTimeout(this.sentenceTimer);
        this.sentenceTimer = setTimeout(() => this._finalizeSentence(), this.SENTENCE_TIMEOUT);
    }

    _finalizeSentence() {
        if (this.sentenceTimer) { clearTimeout(this.sentenceTimer); this.sentenceTimer = null; }
        if (!this.sentence || this.sentence === this.lastSentence) return;

        const finalSentence = this.sentence.trim();
        console.log(`\n🔵 SENTENCE COMPLETE: "${finalSentence}"\n`);
        this.lastSentence = finalSentence;
        this.sentence = "";
        this._translateAndSpeak(finalSentence);
    }

    async _translateAndSpeak(text) {
        if (this.isProcessing || !text) return;
        this.isProcessing = true;
        const start = Date.now();

        try {
            const session = this.activeSessions.get(this.roomId);
            if (!session) return;
            const partner = this.userType === "caller" ? session.receiverConnection : session.callerConnection;
            if (!partner?.myLanguage) { console.log("⚠️ Partner not connected"); return; }

            const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
            console.log(`🌐 ${Date.now() - start}ms: "${text}" → "${translated}"`);

            const data = {
                event: "translation", originalText: text, translatedText: translated,
                fromUser: this.userType, fromLanguage: this.myLanguage, toLanguage: partner.myLanguage
            };
            this._sendToUI(data);
            partner._sendToUI(data);

            // TTS non-blocking
            this._tts(translated, partner.myLanguage).then(audio => {
                if (!audio || partner.ws?.readyState !== 1) return;
                const wav = this._toWav(audio, 48000);
                partner.ws.send(JSON.stringify({ event: "audio_playback", audio: wav.toString("base64"), format: "wav" }));
                console.log(`🔊 TTS done: ${Date.now() - start}ms total`);
            }).catch(e => console.error("TTS error:", e.message));

        } catch (e) {
            console.error("Translation error:", e.message);
        } finally {
            this.isProcessing = false;
        }
    }

    async _translate(text, from, to) {
        const fromLang = (from || "en").split("-")[0];
        const toLang = (to || "en").split("-")[0];
        if (fromLang === toLang) return text;
        const key = `${text}|${fromLang}|${toLang}`;
        if (this.translationCache.has(key)) return this.translationCache.get(key);
        try {
            const [result] = await this.translateClient.translate(text, { from: fromLang, to: toLang });
            if (this.translationCache.size >= this.MAX_TRANSLATION_CACHE)
                this.translationCache.delete(this.translationCache.keys().next().value);
            this.translationCache.set(key, result);
            return result;
        } catch (e) {
            console.error("Translate error:", e.message);
            return text;
        }
    }

    async _tts(text, lang) {
        const voices = {
            en: { languageCode: "en-US", name: "en-US-Neural2-J" },
            hi: { languageCode: "hi-IN", name: "hi-IN-Neural2-A" },
            te: { languageCode: "te-IN", name: "te-IN-Standard-A" },
            ta: { languageCode: "ta-IN", name: "ta-IN-Standard-A" },
            bn: { languageCode: "bn-IN", name: "bn-IN-Standard-A" },
            gu: { languageCode: "gu-IN", name: "gu-IN-Standard-A" },
            kn: { languageCode: "kn-IN", name: "kn-IN-Standard-A" },
            ml: { languageCode: "ml-IN", name: "ml-IN-Standard-A" },
            mr: { languageCode: "mr-IN", name: "mr-IN-Standard-A" },
            pa: { languageCode: "pa-IN", name: "pa-IN-Standard-A" },
            es: { languageCode: "es-ES", name: "es-ES-Neural2-A" },
            fr: { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
            de: { languageCode: "de-DE", name: "de-DE-Neural2-A" },
            pt: { languageCode: "pt-BR", name: "pt-BR-Neural2-A" },
            it: { languageCode: "it-IT", name: "it-IT-Neural2-A" },
            ru: { languageCode: "ru-RU", name: "ru-RU-Standard-A" },
            zh: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A" },
            ja: { languageCode: "ja-JP", name: "ja-JP-Neural2-B" },
            ko: { languageCode: "ko-KR", name: "ko-KR-Neural2-A" },
            ar: { languageCode: "ar-XA", name: "ar-XA-Standard-A" },
            tr: { languageCode: "tr-TR", name: "tr-TR-Neural2-A" },
            nl: { languageCode: "nl-NL", name: "nl-NL-Neural2-A" },
            pl: { languageCode: "pl-PL", name: "pl-PL-Neural2-A" },
            vi: { languageCode: "vi-VN", name: "vi-VN-Neural2-A" },
            th: { languageCode: "th-TH", name: "th-TH-Neural2-C" },
        };
        const base = (lang || "en").split("-")[0];
        const voice = voices[base] || { languageCode: lang, ssmlGender: "NEUTRAL" };
        const key = `${text}|${base}`;
        if (this.ttsCache.has(key)) return this.ttsCache.get(key);
        try {
            const [response] = await this.ttsClient.synthesizeSpeech({
                input: { text }, voice,
                audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000, speakingRate: 1.15 }
            });
            if (this.ttsCache.size >= this.MAX_TTS_CACHE)
                this.ttsCache.delete(this.ttsCache.keys().next().value);
            this.ttsCache.set(key, response.audioContent);
            return response.audioContent;
        } catch (e) {
            console.error("TTS error:", e.message);
            try {
                const [fallback] = await this.ttsClient.synthesizeSpeech({
                    input: { text },
                    voice: { languageCode: voice.languageCode || lang, ssmlGender: "NEUTRAL" },
                    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000, speakingRate: 1.15 }
                });
                return fallback.audioContent;
            } catch (e2) { return null; }
        }
    }

    _getLangCode(lang) {
        const map = {
            en: "en-US", hi: "hi-IN", te: "te-IN", ta: "ta-IN",
            kn: "kn-IN", ml: "ml-IN", mr: "mr-IN", bn: "bn-IN",
            gu: "gu-IN", pa: "pa-IN", ur: "ur-IN",
            es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
            ru: "ru-RU", zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR",
            ar: "ar-XA", tr: "tr-TR", nl: "nl-NL", pl: "pl-PL",
            vi: "vi-VN", th: "th-TH",
        };
        return map[(lang || "en").split("-")[0]] || "en-US";
    }

    _toWav(pcm, rate) {
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

    _sendToUI(data) {
        try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(data)); } catch (e) {}
    }

    _notifyPartner(event, data) {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        const partner = this.userType === "caller" ? session.receiverConnection : session.callerConnection;
        if (partner?.ws?.readyState === 1) partner.ws.send(JSON.stringify({ event, ...data }));
    }

    async cleanup() {
        if (this.sentenceTimer) { clearTimeout(this.sentenceTimer); this.sentenceTimer = null; }
        if (this.sentence && this.sentence !== this.lastSentence) this._finalizeSentence();
        await this._stopStream();
        const session = this.activeSessions.get(this.roomId);
        if (session) {
            if (session.callerConnection === this) session.callerConnection = null;
            if (session.receiverConnection === this) session.receiverConnection = null;
        }
        this._notifyPartner("user_left", {});
        console.log(`🧹 Cleanup: ${this.userType} in ${this.roomId}`);
    }
}

module.exports = VoiceProcessor;
