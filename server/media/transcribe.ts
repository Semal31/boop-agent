/**
 * Local speech-to-text for voice notes and the audio track of videos.
 *
 * The system ffmpeg decodes whatever container iMessage sends (.caf voice
 * notes, .mov/.mp4 video, …) to 16kHz mono f32 PCM; a local Whisper ONNX
 * model — via @huggingface/transformers, the same library that runs the
 * local embeddings — turns the PCM into text. No API key, and no audio
 * leaves the box.
 *
 * The first call downloads the model (~200MB for whisper-small q8) into
 * ~/.cache/huggingface and keeps it loaded in-process afterwards.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const WHISPER_MODEL = process.env.BOOP_WHISPER_MODEL || "onnx-community/whisper-small";
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 4; // f32le
// Hard cap on how much audio gets transcribed. Whisper-small runs a few
// times faster than real time on this box, so 20 minutes keeps worst-case
// turnaround in single-digit minutes; longer media is transcribed up to the
// cap and flagged as truncated rather than rejected.
const MAX_SECONDS = Number(process.env.BOOP_MAX_TRANSCRIBE_SECONDS || 20 * 60);
const DECODE_TIMEOUT_MS = 5 * 60_000;

export interface TranscriptionResult {
  text: string;
  // Duration of the decoded (possibly truncated) audio, in seconds.
  durationSeconds: number;
  truncated: boolean;
}

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber) return transcriber;
  if (loading) return loading;
  const attempt = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    console.log(`[transcribe] loading ${WHISPER_MODEL} (~200MB download on first run)…`);
    const start = Date.now();
    const asr = await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
      dtype: "q8",
    });
    console.log(`[transcribe] model ready in ${Date.now() - start}ms`);
    transcriber = asr;
    return asr;
  })();
  loading = attempt;
  // Same pattern as embeddings.ts: a failed load (network blip mid-download)
  // must clear the slot so the next call re-attempts instead of replaying
  // the cached rejection forever.
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return loading;
}

interface FfmpegResult {
  pcm: Buffer;
  truncated: boolean;
}

function runFfmpeg(inputPath: string, maxBytes: number): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "f32le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg decode timed out after ${DECODE_TIMEOUT_MS / 1000}s`));
    }, DECODE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      total += chunk.byteLength;
      chunks.push(chunk);
      if (total >= maxBytes) {
        truncated = true;
        // We have all the audio we're willing to transcribe — stop decoding.
        proc.kill("SIGKILL");
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg failed to start: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks).subarray(0, maxBytes);
      if (!truncated && code !== 0) {
        reject(new Error(`ffmpeg decode failed: ${stderr.trim().slice(0, 400) || `exit ${code}`}`));
        return;
      }
      resolve({ pcm, truncated });
    });
  });
}

async function decodeToPcm(
  media: Buffer,
): Promise<{ audio: Float32Array; durationSeconds: number; truncated: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), "boop-media-"));
  try {
    // ffmpeg sniffs the container from magic bytes, so no extension needed.
    const inputPath = join(dir, "input");
    await writeFile(inputPath, media);
    const maxBytes = MAX_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
    const { pcm, truncated } = await runFfmpeg(inputPath, maxBytes);
    const sampleBytes = pcm.byteLength - (pcm.byteLength % BYTES_PER_SAMPLE);
    // Copy into a fresh ArrayBuffer — Buffer.concat may hand back pooled
    // memory whose byteOffset isn't 4-byte aligned, which Float32Array rejects.
    const aligned = new ArrayBuffer(sampleBytes);
    new Uint8Array(aligned).set(pcm.subarray(0, sampleBytes));
    const audio = new Float32Array(aligned);
    return { audio, durationSeconds: audio.length / SAMPLE_RATE, truncated };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function doTranscribe(media: Buffer): Promise<TranscriptionResult> {
  const { audio, durationSeconds, truncated } = await decodeToPcm(media);
  if (audio.length === 0) {
    return { text: "", durationSeconds: 0, truncated };
  }
  const asr = await getTranscriber();
  const start = Date.now();
  const out = await asr(
    audio,
    // Whisper natively handles 30s; longer audio needs chunked decoding with
    // overlap so sentences spanning a boundary aren't lost.
    durationSeconds > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {},
  );
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
  console.log(
    `[transcribe] ${durationSeconds.toFixed(1)}s of audio → ${text.length} chars in ${((Date.now() - start) / 1000).toFixed(1)}s${truncated ? " (truncated)" : ""}`,
  );
  return { text, durationSeconds, truncated };
}

// Whisper saturates the CPU; serialize runs so several attachments arriving
// at once don't thrash each other. Order within one message is preserved by
// the caller, which awaits results positionally.
let queue: Promise<unknown> = Promise.resolve();

export function transcribeMedia(media: Buffer): Promise<TranscriptionResult> {
  const run = queue.then(
    () => doTranscribe(media),
    () => doTranscribe(media),
  );
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTranscriptBlock(
  kind: "audio" | "video",
  result: TranscriptionResult,
): string {
  const label =
    kind === "audio" ? "Voice note from the user" : "Audio track of a video the user sent";
  const dur = formatDuration(result.durationSeconds);
  const note = result.truncated
    ? `, transcribed locally — only the first ${dur} (rest cut off)`
    : ", transcribed locally";
  if (!result.text) return `[${label} (${dur})${note}: no speech detected]`;
  return `[${label} (${dur})${note}]:\n"${result.text}"`;
}
