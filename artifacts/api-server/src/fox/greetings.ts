export interface GreetingMatch {
  type: "pagi" | "siang" | "sore" | "malam" | "morning" | "night";
  original: string;
}

const GREETING_PATTERNS: Array<{ pattern: RegExp; type: GreetingMatch["type"] }> = [
  { pattern: /\bselamat pagi\b/i, type: "pagi" },
  { pattern: /\bselamat siang\b/i, type: "siang" },
  { pattern: /\bselamat sore\b/i, type: "sore" },
  { pattern: /\bselamat malam\b/i, type: "malam" },
  { pattern: /\bgood morning\b/i, type: "morning" },
  { pattern: /\bgood night\b/i, type: "night" },
];

/**
 * Detect a time-of-day greeting in the message.
 * Returns the match info, or null if none found.
 */
export function detectGreeting(content: string): GreetingMatch | null {
  for (const { pattern, type } of GREETING_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      return { type, original: match[0] };
    }
  }
  return null;
}
