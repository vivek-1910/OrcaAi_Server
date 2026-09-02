import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import {
  createSarvamSttSocket,
  createSarvamTtsSocket,
  languageCodeFor,
  sarvamApiKeyPresent,
  translateToLanguage,
  ttsLanguageCode,
} from "../tool-providers/sarvam-client.js";

type VoiceQuery = { language?: string };

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function rawToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function rawToBase64(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("base64");
  if (Array.isArray(data)) return Buffer.concat(data).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  return Buffer.from(data).toString("base64");
}

function isJsonMessage(data: RawData): boolean {
  if (typeof data === "string") return true;
  if (Buffer.isBuffer(data)) return data[0] === 123 || data[0] === 91;
  return false;
}

function closeWithError(socket: WebSocket, message: string): void {
  sendJson(socket, { type: "error", message });
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1011, "provider unavailable");
}

async function bridgeStt(socket: WebSocket, language: string): Promise<void> {
  if (!sarvamApiKeyPresent()) {
    closeWithError(socket, "SARVAM_API_KEY is not configured on the server.");
    return;
  }

  try {
    const upstream = await createSarvamSttSocket(language);
    let upstreamReady = false;
    const pendingMessages: RawData[] = [];

    const handleClientMessage = (data: RawData): void => {
      if (!upstreamReady) {
        pendingMessages.push(data);
        return;
      }

      try {
        if (!isJsonMessage(data)) {
          upstream.sendRealtimeAudioInput({ event: "audio_input", audio: rawToBase64(data) });
          return;
        }

        const message = JSON.parse(rawToString(data)) as Record<string, unknown>;
        if (message.event === "audio_input" && typeof message.audio === "string") {
          upstream.sendRealtimeAudioInput({ event: "audio_input", audio: message.audio });
        } else if (message.type === "audio" && typeof message.data === "string") {
          upstream.sendRealtimeAudioInput({ event: "audio_input", audio: message.data });
        } else if (message.event === "flush" || message.type === "flush") {
          upstream.sendRealtimeFlush({ event: "flush" });
        } else if (message.event === "speech_start") {
          upstream.sendRealtimeSpeechStart({ event: "speech_start" });
        } else if (message.event === "speech_end") {
          upstream.sendRealtimeSpeechEnd({ event: "speech_end" });
        } else if (message.event === "ping") {
          upstream.sendRealtimePing({ event: "ping" });
        } else if (message.event === "config.update" && message.config && typeof message.config === "object") {
          const config = message.config as Record<string, unknown>;
          upstream.sendRealtimeConfigUpdate({
            event: "config.update",
            ...(typeof config.language_code === "string" ? { language_code: config.language_code } : {}),
            ...(typeof config.mode === "string" ? { mode: config.mode as never } : {}),
            ...(typeof config.prompt === "string" ? { prompt: config.prompt } : {}),
          });
        } else if (message.event === "end" || message.type === "end") {
          upstream.sendRealtimeEnd({ event: "end" });
        }
      } catch (error) {
        sendJson(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid voice message." });
      }
    };

    socket.on("message", handleClientMessage);
    upstream.on("message", (message) => sendJson(socket, message));
    upstream.on("error", (error) => closeWithError(socket, error.message));
    upstream.on("close", (event) => {
      sendJson(socket, { type: "provider-close", code: event.code });
      if (socket.readyState === WebSocket.OPEN) socket.close(event.code || 1000);
    });
    // The installed Sarvam SDK attaches its event listeners in the socket
    // constructor and again in connect(). Reconnecting the underlying socket
    // avoids forwarding every provider event twice to the browser.
    upstream.socket.reconnect();
    await upstream.waitForOpen();
    upstreamReady = true;
    sendJson(socket, { type: "ready", provider: "sarvam", model: "saaras:v3-realtime", language: languageCodeFor(language), mode: "translate" });
    for (const data of pendingMessages.splice(0)) handleClientMessage(data);
    socket.on("close", () => upstream.close());
  } catch (error) {
    closeWithError(socket, error instanceof Error ? error.message : "Sarvam STT could not start.");
  }
}

async function bridgeTts(socket: WebSocket, language: string): Promise<void> {
  if (!sarvamApiKeyPresent()) {
    closeWithError(socket, "SARVAM_API_KEY is not configured on the server.");
    return;
  }

  try {
    const upstream = await createSarvamTtsSocket();
    let upstreamReady = false;
    const pendingMessages: RawData[] = [];

    const handleClientMessage = (data: RawData): void => {
      if (!upstreamReady) {
        pendingMessages.push(data);
        return;
      }

      try {
        const message = JSON.parse(rawToString(data)) as Record<string, unknown>;
        if ((message.type === "text" || message.event === "text") && typeof message.text === "string") upstream.convert(message.text);
        else if (message.type === "flush" || message.event === "flush") upstream.flush();
        else if (message.type === "ping" || message.event === "ping") upstream.ping();
      } catch (error) {
        sendJson(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid TTS message." });
      }
    };

    socket.on("message", handleClientMessage);
    upstream.on("message", (message) => {
      sendJson(socket, message);
      const event = message as { type?: unknown; data?: { event_type?: unknown } };
      if (event.type === "event" && event.data?.event_type === "final") {
        setTimeout(() => upstream.close(), 0);
      }
    });
    upstream.on("error", (error) => closeWithError(socket, error.message));
    upstream.on("close", (event) => {
      sendJson(socket, { type: "provider-close", code: event.code });
      if (socket.readyState === WebSocket.OPEN) socket.close(event.code || 1000);
    });
    // Avoid the SDK connect() listener duplication; the wrapper constructor
    // has already registered the provider event handlers.
    upstream.socket.reconnect();
    await upstream.waitForOpen();
    upstream.configureConnection({
      type: "config",
      data: {
        model: "bulbul:v3",
        language_code: ttsLanguageCode(language) as never,
        speaker: "shubh",
        pace: 1,
        temperature: 0.6,
        speech_sample_rate: 24000,
        output_audio_codec: "mp3",
        output_audio_bitrate: "128k",
        max_chunk_length: 150,
      },
    });
    upstreamReady = true;
    sendJson(socket, { type: "ready", provider: "sarvam", model: "bulbul:v3", language: ttsLanguageCode(language) });
    for (const data of pendingMessages.splice(0)) handleClientMessage(data);
    socket.on("close", () => upstream.close());
  } catch (error) {
    closeWithError(socket, error instanceof Error ? error.message : "Sarvam TTS could not start.");
  }
}

export async function registerVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/v1/voice/stt",
    { websocket: true },
    (socket, request: FastifyRequest<{ Querystring: VoiceQuery }>) => {
      void bridgeStt(socket, request.query?.language || "auto");
    },
  );

  app.get(
    "/v1/voice/tts",
    { websocket: true },
    (socket, request: FastifyRequest<{ Querystring: VoiceQuery }>) => {
      void bridgeTts(socket, request.query?.language || "English");
    },
  );

  app.post(
    "/v1/voice/translate",
    async (request: FastifyRequest<{ Body: { text?: string; language?: string } }>, reply) => {
      const text = request.body?.text?.trim();
      const language = request.body?.language?.trim() || "English";
      if (!text || text.length > 2000) return reply.code(400).send({ error: "text must contain 1 to 2,000 characters." });
      const result = await translateToLanguage(text, language);
      if (result.status !== "ok") return reply.code(503).send({ error: result.error || "Translation unavailable." });
      return reply.send({ text: result.data, language: ttsLanguageCode(language), sourceLanguage: "en-IN" });
    },
  );
}
