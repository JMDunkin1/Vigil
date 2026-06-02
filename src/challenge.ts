import { randomInt } from "node:crypto";
import type { VigilState, TypingChallenge } from "./types.js";

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
  status: number;

  constructor(message = "Type the challenge text exactly before confirming.") {
    super(message);
    this.status = 423;
  }
}

interface ChallengeCarrier {
  challenge?: TypingChallenge;
}

export function typingChallengeRequired(state: Pick<VigilState, "settings">): boolean {
  return state.settings?.typingChallengeEnabled !== false;
}

export function attachTypingChallenge<T extends object | null | undefined>(
  state: Pick<VigilState, "settings">,
  pending: T,
  kind = "unlock",
  now = new Date()
): T {
  if (!pending) return pending;
  const carrier = pending as ChallengeCarrier;
  if (!typingChallengeRequired(state)) {
    delete carrier.challenge;
    return pending;
  }
  if (carrier.challenge?.text) return pending;
  carrier.challenge = {
    kind,
    text: generateChallengeText(kind),
    createdAt: now.toISOString()
  };
  return pending;
}

export function assertTypingChallenge(
  state: Pick<VigilState, "settings">,
  pending: object | null | undefined,
  value: unknown
): void {
  const carrier = pending as ChallengeCarrier | null | undefined;
  if (!typingChallengeRequired(state) && !carrier?.challenge?.text) return;
  const expected = normalizeChallengeText(carrier?.challenge?.text);
  if (!expected) throw new TypingChallengeError("Challenge text is missing. Request a new unlock.");
  if (normalizeChallengeText(value) !== expected) throw new TypingChallengeError();
}

function generateChallengeText(kind: string): string {
  const label = String(kind || "unlock").replace(/[^a-z-]/gi, "").toLowerCase() || "unlock";
  const words = Array.from({ length: 3 }, () => WORDS[randomInt(WORDS.length)]);
  return `${label} ${words.join(" ")} ${randomInt(100, 1000)}`;
}

function normalizeChallengeText(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}
