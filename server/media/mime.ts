/**
 * Classification for non-image Sendblue media (voice notes, videos).
 * Images keep their own strict allowlist in server/images/mime.ts; audio and
 * video only need a kind + size cap here — ffmpeg sniffs the real container
 * during decode, so a permissive match is safe.
 */

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB — voice notes are well under 5 MB
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB — iMessage compresses video far below this

export type MediaKind = "image" | "audio" | "video" | "unknown";

// iMessage voice notes arrive as .caf (sometimes served as
// application/octet-stream), videos as .mov/.mp4 — the extension fallback
// covers CDNs that drop or genericize the content-type.
const AUDIO_EXTENSIONS = new Set([
  "caf",
  "m4a",
  "mp3",
  "wav",
  "aac",
  "amr",
  "ogg",
  "oga",
  "opus",
  "flac",
]);
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "3gp", "3gpp", "webm", "mkv", "avi"]);

function normalizeContentType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const semi = raw.indexOf(";");
  const trimmed = (semi >= 0 ? raw.slice(0, semi) : raw).trim().toLowerCase();
  return trimmed || undefined;
}

export function urlExtension(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot < 0) return undefined;
    const ext = pathname.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : undefined;
  } catch {
    return undefined;
  }
}

export function classifyMedia(opts: { contentType?: string; url: string }): MediaKind {
  const mime = normalizeContentType(opts.contentType);
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
  }
  const ext = urlExtension(opts.url);
  if (ext) {
    if (AUDIO_EXTENSIONS.has(ext)) return "audio";
    if (VIDEO_EXTENSIONS.has(ext)) return "video";
  }
  return "unknown";
}

export function maxBytesFor(kind: "audio" | "video"): number {
  return kind === "audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
}
