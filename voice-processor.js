// voice-processor.js - Robust Live Translation with Sentence Accumulation
const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;

// Support for cloud deployment: read credentials from env var
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
}

// ✅ SINGLETON Google Cloud clients (shared across all connections)
// Saves ~200-500ms per connection by avoiding re-authentication
const clientConfig = googleCredentials ? { credentials: googleCredentials } : {};
const sharedSpeechClient = new speech.SpeechClient(clientConfig);
const sharedTtsClient = new textToSpeech.TextToSpeechClient(clientConfig);
const sharedTranslateClient = new Translate(googleCredentials ? { credentials: googleCredentials } : {});

// Indian language codes for faster timeout
const INDIAN_LANGS = ['te', 'hi', 'ta', 'bn', 'gu', 'kn', 'ml', 'mr', 'pa', 'ur'];

class VoiceProcessor {
    constructor(websocket, activeSessions) {
        this.ws = websocket;
        this.activeSessions = activeSessions;

        // ✅ Use shared singleton Google Cloud clients
        this.speechClient = sharedSpeechClient;
        this.ttsClient = sharedTtsClient;
        this.translateClient = sharedTranslateClient;

        // User info
        this.roomId = null;
        this.userType = null;
        this.myLanguage = null;
        this.myName = null;

        // STT state - SIMPLIFIED
        this.recognizeStream = null;
        this.isStreaming = false;
        this.streamCreatedAt = 0;

        // Sentence building - THE KEY FIX
        this.sentence = "";           // Current accumulated sentence (from finals)
        this.lastInterim = "";        // Backup: latest interim result
        this.lastSentence = "";       // Last processed sentence
        this.sentenceTimer = null;    // Timer to finalize sentence
        this.SENTENCE_TIMEOUT = 1200; // Default: 1.2s (faster)

        // Processing Queue
        this.sentenceQueue = [];
        this.isProcessingQueue = false;
        this.isFinalizing = false; // Flag to prevent double-finalization during restarts

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

                // ✅ Dynamic sentence timeout: faster for Indian languages
                const baseLang = (this.myLanguage || 'en').split('-')[0];
                if (INDIAN_LANGS.includes(baseLang)) {
                    this.SENTENCE_TIMEOUT = 1000; // 1.0s for Indian languages
                    console.log(`⚡ Indian language detected (${baseLang}), using fast timeout: ${this.SENTENCE_TIMEOUT}ms`);
                }

                // Pre-warm STT stream after a short delay to reduce cold-start latency
                setTimeout(() => {
                    if (!this.isStreaming) {
                        console.log(`🔥 Pre-warming STT stream for ${this.myLanguage}...`);
                        this._startStream();
                    }
                }, 100);

                // ✅ Pre-warm Translate + TTS clients (first call has extra latency)
                setTimeout(async () => {
                    try {
                        const warmStart = Date.now();
                        const targetLang = this.myLanguage || "en-US";
                        await Promise.all([
                            this.translateClient.translate("hello", { to: "en" }),
                            this.ttsClient.synthesizeSpeech({
                                input: { text: "." },
                                voice: { languageCode: "en-US" },
                                audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000 }
                            }),
                            // Also warm up the current user's language
                            this.ttsClient.synthesizeSpeech({
                                input: { text: "." },
                                voice: { languageCode: targetLang.split("-")[0] === "en" ? "es-ES" : targetLang },
                                audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000 }
                            })
                        ]);
                        console.log(`🔥 Translate + TTS warmed up in ${Date.now() - warmStart}ms`);
                    } catch (e) { /* ignore warm-up errors */ }
                }, 200);
                break;
            case "audio":
                await this._processAudio(msg.audio);
                break;

            // WebRTC Video Signaling - relay to partner
            case "video-offer":
                console.log(`📹 Relaying video offer from ${this.userType}`);
                this._notifyPartner("video-offer", { sdp: msg.sdp });
                break;
            case "video-answer":
                console.log(`📹 Relaying video answer from ${this.userType}`);
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

    _registerConnection() {
        const session = this.activeSessions.get(this.roomId);
        if (!session) return;
        if (this.userType === "caller") session.callerConnection = this;
        else session.receiverConnection = this;
    }

    async _processAudio(base64Audio) {
        if (!this.myLanguage) return;

        const buffer = Buffer.from(base64Audio, "base64");

        // Ensure stream is running
        if (!this.isStreaming) {
            await this._startStream();
        }

        // Check if we need to restart (Google has ~60s limit)
        const streamAge = Date.now() - this.streamCreatedAt;
        if (streamAge > 50000) { // Restart every 50s for safety
            console.log("🔄 Restarting stream (age limit)");
            await this._restartStream();
        }

        // Send ALL audio to Google (let it decide what's speech)
        if (this.recognizeStream) {
            try {
                this.recognizeStream.write(buffer);
            } catch (e) {
                console.error("Write error:", e.message);
                await this._restartStream();
            }
        }

        // DON'T reset timer here - only reset when we get actual STT results
    }

    async _startStream() {
        if (this.isStreaming) return;

        const langCode = this._getLangCode(this.myLanguage);

        try {
            this.recognizeStream = this.speechClient
                .streamingRecognize({
                    config: {
                        encoding: "LINEAR16",
                        sampleRateHertz: 48000,
                        languageCode: langCode,
                        enableAutomaticPunctuation: true,
                        model: "latest_long",
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
            this.streamCreatedAt = Date.now();
            console.log(`🎤 Stream started: ${langCode}`);
        } catch (e) {
            console.error("Failed to start stream:", e.message);
            this.isStreaming = false;
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
        if (this.isFinalizing) return;
        this.isFinalizing = true;

        if (this.sentenceTimer) {
            clearTimeout(this.sentenceTimer);
            this.sentenceTimer = null;
        }

        // ✅ USE INTERIM BACKUP: If no "final" results arrived but we have interim speech
        if (!this.sentence && this.lastInterim && this.lastInterim !== this.lastSentence) {
            console.log(`🔄 Using interim backup for finalization: "${this.lastInterim}"`);
            this.sentence = this.lastInterim;
        }

        if (!this.sentence || this.sentence === this.lastSentence) {
            this.isFinalizing = false;
            return;
        }

        let finalSentence = this.sentence.trim();

        // ✅ STRIP HISTORY: If Google sent us the history of the whole stream, 
        // remove the parts we already processed in the previous sentence.
        if (this.lastSentence && finalSentence.startsWith(this.lastSentence)) {
            const newPart = finalSentence.substring(this.lastSentence.length).trim();
            if (newPart) {
                console.log(`✂️ Stripped history. New part: "${newPart}"`);
                finalSentence = newPart;
            } else {
                // It was all history, nothing new
                this.isFinalizing = false;
                this.sentence = "";
                return;
            }
        }

        console.log(`\n🔵 SENTENCE COMPLETE: "${finalSentence}"\n`);

        this.lastSentence = this.sentence.trim(); // Store the FULL history to strip next time
        this.sentence = "";
        this.lastInterim = ""; 

        // Add to queue and process
        this.sentenceQueue.push(finalSentence);
        this._processQueue();

        this.isFinalizing = false;
    }

    async _processQueue() {
        if (this.isProcessingQueue || this.sentenceQueue.length === 0) return;
        this.isProcessingQueue = true;

        while (this.sentenceQueue.length > 0) {
            const text = this.sentenceQueue.shift();
            if (!text) continue;

            const start = Date.now();

            try {
                const session = this.activeSessions.get(this.roomId);
                if (!session) continue;

                const partner = this.userType === "caller"
                    ? session.receiverConnection
                    : session.callerConnection;

                if (!partner?.myLanguage) {
                    console.log("⚠️ Partner not connected");
                    continue;
                }

                // 1. Translate
                const translated = await this._translate(text, this.myLanguage, partner.myLanguage);
                const translateTime = Date.now() - start;
                console.log(`🌐 [${translateTime}ms] TRANSLATE: "${text}" → "${translated}"`);

                // 2. IMMEDIATELY send text to both users (don't wait for TTS!)
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
                console.log(`⚡ [${Date.now() - start}ms] Text sent to UI`);

                // 3. Generate TTS in background
                const ttsStart = Date.now();
                const audio = await this._tts(translated, partner.myLanguage);
                const ttsTime = Date.now() - ttsStart;

                // 4. Send audio
                if (audio && partner.ws?.readyState === 1) {
                    // Google TTS LINEAR16 sometimes returns a WAV header already.
                    // If it does, don't prepend another one to avoid corrupted audio starts.
                    const isRiff = audio.length >= 4 && audio.slice(0, 4).toString() === "RIFF";
                    const wav = isRiff ? audio : this._toWav(audio, 24000);

                    partner.ws.send(JSON.stringify({
                        event: "audio_playback",
                        audio: wav.toString("base64"),
                        format: "wav"
                    }));
                    console.log(`🔊 [${ttsTime}ms] TTS generated and sent. Total Pipeline: ${Date.now() - start}ms`);
                }
            } catch (e) {
                console.error("Translation error:", e.message);
            }
        }

        this.isProcessingQueue = false;
    }

    async _translate(text, from, to) {
        const fromLang = (from || "en").split("-")[0];
        const toLang = (to || "en").split("-")[0];
        if (fromLang === toLang) return text;

        try {
            const [result] = await this.translateClient.translate(text, { from: fromLang, to: toLang });
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

            // Indian Languages
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

        try {
            const [response] = await this.ttsClient.synthesizeSpeech({
                input: { text },
                voice,
                audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, speakingRate: 1.1 }
            });
            return response.audioContent;
        } catch (e) {
            console.error("TTS error:", e.message);
            return null;
        }
    }

    _getLangCode(lang) {
        const map = {
            // English
            en: "en-US",
            // ✅ All Indian languages (previously missing: bn, gu, kn, ml, mr, pa, ur)
            hi: "hi-IN", te: "te-IN", ta: "ta-IN",
            bn: "bn-IN", gu: "gu-IN", kn: "kn-IN",
            ml: "ml-IN", mr: "mr-IN", pa: "pa-IN", ur: "ur-IN",
            // European
            es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-BR",
            it: "it-IT", nl: "nl-NL", pl: "pl-PL", ru: "ru-RU",
            // Asian
            zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR",
            // Middle Eastern
            ar: "ar-XA", tr: "tr-TR", he: "he-IL"
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
