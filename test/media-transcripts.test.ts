import { describe, it, expect } from "vitest";
import { formatDuration, formatTranscriptBlock } from "../server/media/transcribe.js";
import { composeInboundContent } from "../server/sendblue.js";

describe("formatDuration", () => {
  it("formats m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(7.4)).toBe("0:07");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });
});

describe("formatTranscriptBlock", () => {
  it("labels voice notes as the user's spoken words", () => {
    const block = formatTranscriptBlock("audio", {
      text: "remember to buy basil",
      durationSeconds: 7,
      truncated: false,
    });
    expect(block).toContain("Voice note from the user");
    expect(block).toContain("0:07");
    expect(block).toContain('"remember to buy basil"');
  });

  it("labels video audio as sent content", () => {
    const block = formatTranscriptBlock("video", {
      text: "first, add 20 drops of bergamot",
      durationSeconds: 95,
      truncated: false,
    });
    expect(block).toContain("Audio track of a video the user sent");
    expect(block).toContain("1:35");
  });

  it("flags truncated transcripts", () => {
    const block = formatTranscriptBlock("video", {
      text: "long tutorial",
      durationSeconds: 1200,
      truncated: true,
    });
    expect(block).toMatch(/only the first 20:00/);
  });

  it("notes when no speech was detected", () => {
    const block = formatTranscriptBlock("audio", {
      text: "",
      durationSeconds: 3,
      truncated: false,
    });
    expect(block).toContain("no speech detected");
  });
});

describe("composeInboundContent", () => {
  it("appends transcript blocks after the typed caption", () => {
    const out = composeInboundContent("remember how to make this cologne", [
      '[Audio track of a video the user sent (1:35), transcribed locally]:\n"add bergamot"',
    ]);
    expect(out.startsWith("remember how to make this cologne")).toBe(true);
    expect(out).toContain("add bergamot");
    expect(out.split("\n\n")).toHaveLength(2);
  });

  it("is just the transcript when there is no caption", () => {
    const out = composeInboundContent("", ['[Voice note from the user (0:07)]:\n"hi"']);
    expect(out).toBe('[Voice note from the user (0:07)]:\n"hi"');
  });

  it("passes plain text messages through unchanged", () => {
    expect(composeInboundContent("hello", [])).toBe("hello");
  });

  it("keeps multiple attachments in order", () => {
    const out = composeInboundContent("two things", ["[Voice note A]", "[Voice note B]"]);
    expect(out.indexOf("[Voice note A]")).toBeLessThan(out.indexOf("[Voice note B]"));
  });
});
