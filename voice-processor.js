// voice-processor.js - Robust Live Translation with Sentence Accumulation
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// Support for cloud deployment: read credentials from env var
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
}

class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws = websocket;
        this.activeSessions = activeSessions;

        // Google Cloud clients (use env credentials if available)
        const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};
        this.speechClient = new speech.SpeechClient(clientConfig);
        this.ttsClient = new textToSpeech.TextToSpeechClient(clientConfig);
        this.translateClient = new Translate(googleCredentials ? { credentials: googleCredentials } : {});

        // User info
        this.roomId = null;
        this.userType = null;
        this.myLanguage = null;
        this.myName = null;

        // STT state
        this.recognizeStream = null;
        this.isStreaming = false;
        this.isStartingStream = false; // Prevents multiple parallel start attempts
        this.streamCreatedAt = 0;
        this.audioBuffer = [];         // Buffers audio while connection is opening

        // Sentence building - THE KEY FIX
        this.sentence = "";           // Current accumulated sentence (from finals)
        this.lastInterim = "";        // Backup: latest interim result
        this.lastSentence = "";       // Last processed sentence
        this.sentenceTimer = null;    // Timer to finalize sentence
        this.SENTENCE_TIMEOUT = 1000; // 1s of silence = end of sentence (was 1.5s)

        // Processing lock
        this.isProcessing = false;

        // Caches for translation & TTS (avoid redundant API calls)
        this.translationCache = new Map(); // key: "text|from|to" → translated text
        this.ttsCache = new Map();         // key: "text|lang" → audio buffer
        this.MAX_TRANSLATION_CACHE = 100;
        this.MAX_TTS_CACHE = 50;

        // Bind handlers
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
                
                // Pre-warm STT stream IMMEDIATELY
                if (!this.isStreaming && !this.isStartingStream) {
                    console.log(`🔥 Pre-warming STT stream for ${this.myLanguage}...`);
                    this._startStream().then(() => {
                        if (this.recognizeStream) {
                            const silence = Buffer.alloc(9600); // 100ms at 48kHz
                            try { this.recognizeStream.write(silence); } catch (e) { }
                            console.log(`🔥 Warm-up audio sent for ${this.myLanguage}`);
                        }
                    });
                }
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

    _registerConnection() {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        if (this.userType === "caller") session.callerConnection = this;
        else session.receiverConnection = this;
    }

    async _processAudio(base64Audio) {
        if (!this.myLanguage) return;

        const buffer = Buffer.from(base64Audio, "base64");

        // If currently starting, buffer the audio so we don't lose the first words
        if (this.isStartingStream) {
            this.audioBuffer.push(buffer);
            if (this.audioBuffer.length > 100) this.audioBuffer.shift(); // Keep last 2-3 seconds
            return;
        }

        // Ensure stream is running
        if (!this.isStreaming) {
            this._startStream();
            this.audioBuffer.push(buffer);
            return;
        }

        // Check if we need to restart (Google has ~60s limit)
        const streamAge = Date.now() - this.streamCreatedAt;
        if (streamAge > 55000) { 
            console.log("🔄 Restarting stream (age limit)");
            this._restartStream();
        }

        // Send audio to Google
        if (this.recognizeStream) {
            try {
                this.recognizeStream.write(buffer);
            } catch (e) {
                console.error("Write error:", e.message);
                this._restartStream();
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
                        sampleRateHertz: 16000,
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

            // Replay any audio that arrived while we were starting
            if (this.audioBuffer.length > 0) {
                const chunks = this.audioBuffer.splice(0);
                chunks.forEach(chunk => {
                    try { this.recognizeStream.write(chunk); } catch (e) {}
                });
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
            try { this.recognizeStream.end(); } catch (e) { }
        }
        this.recognizeStream = null;
        this.isStreaming = false;
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

        const isFinal = result.isFinal;

        if (isFinal) {
            // ACCUMULATE final results into the sentence
            if (this.sentence) {
                this.sentence += " " + transcript;
            } else {
                this.sentence = transcript;
            }
            this.lastInterim = ""; // Clear interim since we got final
            console.log(`📝 Accumulated: "${this.sentence}"`);
        } else {
            // Save interim as backup (in case stream times out)
            const preview = this.sentence ? this.sentence + " " + transcript : transcript;
            this.lastInterim = preview; // SAVE FOR BACKUP
            console.log(`⏳ Speaking: "${preview}"`);
            this._sendToUI({ event: "transcript_interim", text: preview });
        }

        // Reset timer - user is still speaking
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

        // Use interim as backup if no finals accumulated
        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            console.log(`🔄 Using interim backup: "${this.lastInterim}"`);
            this.sentence = this.lastInterim;
        }

        // Process any accumulated sentence
        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalizeSentence();
        }

        this.lastInterim = ""; // Clear interim after use
    }

    _resetSentenceTimer() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
        }
        this.sentenceTimer = setTimeout(() => {
            this._finalizeSentence();
        }, this.SENTENCE_TIMEOUT);
    }

    _finalizeSentence() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
            this.sentenceTimer = null;
        }

        if (!this.sentence || this.sentence === this.lastSentence) {
            return;
        }

        const finalSentence = this.sentence.trim();
        console.log(`\n🔵 SENTENCE COMPLETE: "${finalSentence}"\n`);

        this.lastSentence = finalSentence;
        this.sentence = "";

        // Translate and speak
        this._translateAndSpeak(finalSentence);
    }

    async _translateAndSpeak(text) {
        if (this.isProcessing || !text) return;
        this.isProcessing = true;

        const start = Date.now();

        try {
            const session = this.activeSessions.get(this.roomId);
            if (!session) return;

            const partner = this.userType === "caller"
                ? session.receiverConnection
                : session.callerConnection;

            if (!partner?.myLanguage) {
                console.log("⚠️ Partner not connected");
                return;
            }

            // Step 1: Translate (with cache)
            const t0 = Date.now();
            const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
            const translateMs = Date.now() - t0;

            // Send translation text to both users immediately (don't wait for TTS)
            const data = {
                event: "translation",
                originalText: text,
                translatedText: translated,
                fromUser: this.userType,
                fromLanguage: this.myLanguage,
                toLanguage: partner.myLanguage
            };
            this._sendToUI(data);
            partner._sendToUI(data);

            // Step 2: Generate TTS (with cache)
            const t1 = Date.now();
            const audio = await this._tts(translated, partner.myLanguage);
            const ttsMs = Date.now() - t1;

            if (audio && partner.ws?.readyState === 1) {
                const wav = this._toWav(audio, 48000);
                partner.ws.send(JSON.stringify({
                    event: "audio_playback",
                    audio: wav.toString("base64"),
                    format: "wav"
                }));
            }

            const totalMs = Date.now() - start;
            console.log(`⏱️ Translate: ${translateMs}ms | TTS: ${ttsMs}ms | Total: ${totalMs}ms | "${text}" → "${translated}"`);
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

        // Check cache first
        const cacheKey = `${text}|${fromLang}|${toLang}`;
        if (this.translationCache.has(cacheKey)) {
            console.log(`💾 Translation cache hit`);
            return this.translationCache.get(cacheKey);
        }

        try {
            const [result] = await this.translateClient.translate(text, { from: fromLang, to: toLang });

            // Store in cache (evict oldest if full)
            if (this.translationCache.size >= this.MAX_TRANSLATION_CACHE) {
                const oldest = this.translationCache.keys().next().value;
                this.translationCache.delete(oldest);
            }
            this.translationCache.set(cacheKey, result);

            return result;
        } catch (e) {
            console.error("Translate error:", e.message);
            return text;
        }
    }

    async _tts(text, lang) {
        // Comprehensive language support with Neural2 where available
        const voices = {
            // Major World Languages
            en: { languageCode: "en-US", name: "en-US-Neural2-J" },
            es: { languageCode: "es-ES", name: "es-ES-Neural2-A" },
            fr: { languageCode: "fr-FR", name: "fr-FR-Neural2-A" },
            de: { languageCode: "de-DE", name: "de-DE-Neural2-A" },
            pt: { languageCode: "pt-BR", name: "pt-BR-Neural2-A" },
            it: { languageCode: "it-IT", name: "it-IT-Neural2-A" },
            ru: { languageCode: "ru-RU", name: "ru-RU-Standard-A" },

            // Asian Languages
            zh: { languageCode: "cmn-CN", name: "cmn-CN-Standard-A" },
            ja: { languageCode: "ja-JP", name: "ja-JP-Neural2-B" },
            ko: { languageCode: "ko-KR", name: "ko-KR-Neural2-A" },
            vi: { languageCode: "vi-VN", name: "vi-VN-Neural2-A" },
            th: { languageCode: "th-TH", name: "th-TH-Neural2-C" },
            id: { languageCode: "id-ID", name: "id-ID-Standard-A" },
            ms: { languageCode: "ms-MY", name: "ms-MY-Standard-A" },
            fil: { languageCode: "fil-PH", name: "fil-PH-Neural2-A" },

            // Indian Languages (Neural2 for Hindi, Standard for others)
            hi: { languageCode: "hi-IN", name: "hi-IN-Neural2-A" },
            te: { languageCode: "te-IN", name: "te-IN-Standard-A" },
            ta: { languageCode: "ta-IN", name: "ta-IN-Standard-A" },
            bn: { languageCode: "bn-IN", name: "bn-IN-Standard-A" },
            gu: { languageCode: "gu-IN", name: "gu-IN-Standard-A" },
            kn: { languageCode: "kn-IN", name: "kn-IN-Standard-A" },
            ml: { languageCode: "ml-IN", name: "ml-IN-Standard-A" },
            mr: { languageCode: "mr-IN", name: "mr-IN-Standard-A" },
            pa: { languageCode: "pa-IN", name: "pa-IN-Standard-A" },

            // Middle Eastern Languages
            ar: { languageCode: "ar-XA", name: "ar-XA-Standard-A" },
            he: { languageCode: "he-IL", name: "he-IL-Standard-A" },
            tr: { languageCode: "tr-TR", name: "tr-TR-Neural2-A" },
            fa: { languageCode: "fa-IR", name: "fa-IR-Standard-A" },

            // European Languages
            nl: { languageCode: "nl-NL", name: "nl-NL-Neural2-A" },
            pl: { languageCode: "pl-PL", name: "pl-PL-Neural2-A" },
            sv: { languageCode: "sv-SE", name: "sv-SE-Neural2-A" },
            da: { languageCode: "da-DK", name: "da-DK-Neural2-D" },
            no: { languageCode: "nb-NO", name: "nb-NO-Neural2-A" },
            fi: { languageCode: "fi-FI", name: "fi-FI-Neural2-A" },
            el: { languageCode: "el-GR", name: "el-GR-Neural2-A" },
            cs: { languageCode: "cs-CZ", name: "cs-CZ-Standard-A" },
            ro: { languageCode: "ro-RO", name: "ro-RO-Standard-A" },
            hu: { languageCode: "hu-HU", name: "hu-HU-Standard-A" },
            uk: { languageCode: "uk-UA", name: "uk-UA-Standard-A" },

            // Other
            af: { languageCode: "af-ZA", name: "af-ZA-Standard-A" }
        };

        const base = (lang || "en").split("-")[0];
        const voice = voices[base] || { languageCode: lang, ssmlGender: "NEUTRAL" };

        // Check TTS cache first
        const ttsCacheKey = `${text}|${base}`;
        if (this.ttsCache.has(ttsCacheKey)) {
            console.log(`💾 TTS cache hit`);
            return this.ttsCache.get(ttsCacheKey);
        }

        try {
            const [response] = await this.ttsClient.synthesizeSpeech({
                input: { text },
                voice,
                audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000, speakingRate: 1.15 }
            });

            // Store in cache (evict oldest if full)
            if (this.ttsCache.size >= this.MAX_TTS_CACHE) {
                const oldest = this.ttsCache.keys().next().value;
                this.ttsCache.delete(oldest);
            }
            this.ttsCache.set(ttsCacheKey, response.audioContent);

            return response.audioContent;
        } catch (e) {
            console.error("TTS error:", e.message);
            // Fallback: retry with just languageCode + NEUTRAL gender (no specific voice name)
            try {
                console.log(`🔄 TTS fallback for ${base}...`);
                const [fallback] = await this.ttsClient.synthesizeSpeech({
                    input: { text },
                    voice: { languageCode: voice.languageCode || lang, ssmlGender: "NEUTRAL" },
                    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 48000, speakingRate: 1.15 }
                });
                return fallback.audioContent;
            } catch (e2) {
                console.error("TTS fallback error:", e2.message);
                return null;
            }
        }
    }

    _getLangCode(lang) {
        const map = {
            en: "en-US", hi: "hi-IN", te: "te-IN", ta: "ta-IN",
            es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
            ru: "ru-RU", zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR", ar: "ar-XA"
        };
        return map[(lang || "en").split("-")[0]] || "en-US";
    }

    _toWav(pcm, rate) {
        const h = Buffer.alloc(44);
        h.write("RIFF", 0);
        h.writeUInt32LE(36 + pcm.length, 4);
        h.write("WAVE", 8);
        h.write("fmt ", 12);
        h.writeUInt32LE(16, 16);
        h.writeUInt16LE(1, 20);
        h.writeUInt16LE(1, 22);
        h.writeUInt32LE(rate, 24);
        h.writeUInt32LE(rate * 2, 28);
        h.writeUInt16LE(2, 32);
        h.writeUInt16LE(16, 34);
        h.write("data", 36);
        h.writeUInt32LE(pcm.length, 40);
        return Buffer.concat([h, pcm]);
    }

    _sendToUI(data) {
        try {
            if (this.ws?.readyState === 1) {
                this.ws.send(JSON.stringify(data));
            }
        } catch (e) { }
    }

    _notifyPartner(event, data) {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        const partner = this.userType === "caller" ? session.receiverConnection : session.callerConnection;
        if (partner?.ws?.readyState === 1) {
            partner.ws.send(JSON.stringify({ event, ...data }));
        }
    }

    async cleanup() {
        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
            this.sentenceTimer = null;
        }

        // Process any remaining sentence
        if (this.sentence && this.sentence !== this.lastSentence) {
            this._finalizeSentence();
        }

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