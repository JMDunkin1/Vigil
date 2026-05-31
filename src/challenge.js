import { randomInt } from "node:crypto";

const WORDS = [
  "steady",
  "useful",
  "choice",
  "tomorrow",
  "quiet",
  "return",
  "patient",
  "anchor",
  "focus",
  "enough",
  "clear",
  "sleep"
];

export class TypingChallengeError extends Error {
  constructor(message = "Type the challenge text exactly before confirming.") {
    super(message);
    this.status = 423;
  }
}

export function typingChallengeRequired(state) {
  return state.settings?.typingChallengeEnabled !== false;
}

export function attachTypingChallenge(state, pending, kind = "unlock", now = new Date()) {
  if (!pending) return pending;
  if (!typingChallengeRequired(state)) {
    delete pending.challenge;
    return pending;
  }
  if (pending.challenge?.text) return pending;
  pending.challenge = {
    kind,
    text: generateChallengeText(kind),
    createdAt: now.toISOString()
  };
  return pending;
}

export function assertTypingChallenge(state, pending, value) {
  if (!typingChallengeRequired(state) && !pending?.challenge?.text) return;
  const expected = normalizeChallengeText(pending?.challenge?.text);
  if (!expected) throw new TypingChallengeError("Challenge text is missing. Request a new unlock.");
  if (normalizeChallengeText(value) !== expected) throw new TypingChallengeError();
}

function generateChallengeText(kind) {
  const label = String(kind || "unlock").replace(/[^a-z-]/gi, "").toLowerCase() || "unlock";
  const words = Array.from({ length: 3 }, () => WORDS[randomInt(WORDS.length)]);
  return `${label} ${words.join(" ")} ${randomInt(100, 1000)}`;
}

function normalizeChallengeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
