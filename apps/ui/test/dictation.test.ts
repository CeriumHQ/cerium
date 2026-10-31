import { describe, expect, it } from "@effect/vitest";

import {
  cleanTranscript,
  hasSound,
  languageOfLocale,
  microphoneProblem,
  PIECE_SECONDS,
  pieceEnd,
  SAMPLE_RATE,
  spacedInsert,
} from "../src/features/dictation/model.ts";

describe("cleanTranscript", () => {
  it("drops Whisper's sound tags and the spacing around them", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] Add a test. (keyboard clicking) *coughs* ")).toBe("Add a test.");
  });

  it("counts a lone sign-off on near silence as nothing heard", () => {
    expect(cleanTranscript(" Thank you.")).toBe("");
    expect(cleanTranscript("Thanks for watching!")).toBe("");
    expect(cleanTranscript("you")).toBe("");
    expect(cleanTranscript("Thank you for the review, merge it.")).toBe(
      "Thank you for the review, merge it.",
    );
  });
});

describe("spacedInsert", () => {
  it("spaces dictation from the words beside the caret", () => {
    expect(spacedInsert("then test it", "e", "A")).toBe(" then test it ");
  });

  it("adds no space at an edge, after a space or line break, or before punctuation", () => {
    expect(spacedInsert("hello", undefined, undefined)).toBe("hello");
    expect(spacedInsert("hello", " ", "\n")).toBe("hello");
    expect(spacedInsert("hello", "\n", ".")).toBe("hello");
  });
});

describe("pieceEnd", () => {
  const tone = (seconds: number) =>
    Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, index) => 0.3 * Math.sin(index / 5));

  it("waits until a piece is full", () => {
    expect(pieceEnd(tone(PIECE_SECONDS - 1))).toBeUndefined();
  });

  it("cuts a full piece at its quietest moment near the end", () => {
    const samples = tone(PIECE_SECONDS + 2);
    const pause = (PIECE_SECONDS - 2) * SAMPLE_RATE;
    samples.fill(0, pause, pause + SAMPLE_RATE / 4);
    const end = pieceEnd(samples)!;
    expect(end).toBeGreaterThanOrEqual(pause);
    expect(end).toBeLessThanOrEqual(pause + SAMPLE_RATE / 4);
  });
});

describe("hasSound", () => {
  it("tells speech from silence", () => {
    expect(hasSound(new Float32Array(SAMPLE_RATE))).toBe(false);
    expect(hasSound(Float32Array.from([0, 0.2, -0.1]))).toBe(true);
  });
});

describe("microphoneProblem", () => {
  it("names what getUserMedia's error means", () => {
    expect(microphoneProblem(new DOMException("denied", "NotAllowedError"))).toBe("blocked");
    expect(microphoneProblem(new DOMException("none", "NotFoundError"))).toBe("noMicrophone");
    expect(microphoneProblem(new DOMException("in use", "NotReadableError"))).toBe("busy");
    expect(microphoneProblem(new Error("odd"))).toBe("failed");
  });
});

describe("languageOfLocale", () => {
  it("takes the system's language when Whisper is offered it, else English", () => {
    expect(languageOfLocale("pt-BR")).toBe("pt");
    expect(languageOfLocale("nb-NO")).toBe("no");
    expect(languageOfLocale("xx")).toBe("en");
  });
});
