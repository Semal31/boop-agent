import { describe, it, expect } from "vitest";
import {
  classifyMedia,
  urlExtension,
  maxBytesFor,
  MAX_AUDIO_BYTES,
  MAX_VIDEO_BYTES,
} from "../server/media/mime.js";

describe("classifyMedia", () => {
  it("classifies audio content-types as audio", () => {
    expect(classifyMedia({ contentType: "audio/x-caf", url: "https://cdn.example.com/a" })).toBe(
      "audio",
    );
    expect(classifyMedia({ contentType: "audio/mp4", url: "https://cdn.example.com/a" })).toBe(
      "audio",
    );
    expect(
      classifyMedia({ contentType: "audio/mpeg; charset=binary", url: "https://x.com/a" }),
    ).toBe("audio");
  });

  it("classifies video content-types as video", () => {
    expect(
      classifyMedia({ contentType: "video/quicktime", url: "https://cdn.example.com/v" }),
    ).toBe("video");
    expect(classifyMedia({ contentType: "video/mp4", url: "https://cdn.example.com/v" })).toBe(
      "video",
    );
  });

  it("classifies image content-types as image", () => {
    expect(classifyMedia({ contentType: "image/jpeg", url: "https://cdn.example.com/i" })).toBe(
      "image",
    );
    // Unsupported image subtypes still classify as image — the strict
    // allowlist downstream rejects them with the existing error.
    expect(classifyMedia({ contentType: "image/heic", url: "https://cdn.example.com/i" })).toBe(
      "image",
    );
  });

  it("falls back to URL extension when content-type is generic", () => {
    expect(
      classifyMedia({
        contentType: "application/octet-stream",
        url: "https://storage.example.com/voice-note.caf",
      }),
    ).toBe("audio");
    expect(
      classifyMedia({
        contentType: "application/octet-stream",
        url: "https://storage.example.com/clip.mov",
      }),
    ).toBe("video");
    expect(
      classifyMedia({ contentType: undefined, url: "https://storage.example.com/song.m4a" }),
    ).toBe("audio");
  });

  it("ignores query strings when reading the extension", () => {
    expect(
      classifyMedia({
        contentType: undefined,
        url: "https://cdn.example.com/media/note.caf?token=abc.def",
      }),
    ).toBe("audio");
  });

  it("returns unknown for unclassifiable media", () => {
    expect(
      classifyMedia({ contentType: "application/pdf", url: "https://x.com/doc.pdf" }),
    ).toBe("unknown");
    expect(classifyMedia({ contentType: undefined, url: "https://x.com/blob" })).toBe("unknown");
  });

  it("prefers content-type over extension", () => {
    expect(
      classifyMedia({ contentType: "video/mp4", url: "https://x.com/misnamed.caf" }),
    ).toBe("video");
  });
});

describe("urlExtension", () => {
  it("extracts simple extensions", () => {
    expect(urlExtension("https://x.com/a/b/c.mov")).toBe("mov");
  });
  it("lowercases", () => {
    expect(urlExtension("https://x.com/A.CAF")).toBe("caf");
  });
  it("returns undefined without an extension or for junk", () => {
    expect(urlExtension("https://x.com/blob")).toBeUndefined();
    expect(urlExtension("not a url")).toBeUndefined();
  });
});

describe("size caps", () => {
  it("audio cap is smaller than video cap", () => {
    expect(MAX_AUDIO_BYTES).toBeLessThan(MAX_VIDEO_BYTES);
    expect(maxBytesFor("audio")).toBe(MAX_AUDIO_BYTES);
    expect(maxBytesFor("video")).toBe(MAX_VIDEO_BYTES);
  });
});
