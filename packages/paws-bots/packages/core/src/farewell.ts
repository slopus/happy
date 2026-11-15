/**
 * Lead-ins and tails that may wrap a closing phrase without changing what it means.
 * Spanish is written without accents, which `isFarewell` strips before matching.
 */
const FILLER = [
  "thank you",
  "for today",
  "for now",
  "alright",
  "perfect",
  "thanks",
  "great",
  "okay",
  "cool",
  "bye",
  "ok",
  "muchas gracias",
  "gracias",
  "por hoy",
  "por ahora",
  "perfecto",
  "genial",
  "listo",
  "bueno",
  "dale",
];

const CLOSING = [
  "that'll be all",
  "that will be all",
  "that's all for now",
  "that's everything",
  "that's all",
  "that's it",
  "talk to you later",
  "catch you later",
  "talk later",
  "goodbye",
  "good bye",
  "see you",
  "see ya",
  "end the call",
  "end call",
  "hang up",
  "i'm done",
  "we're done",
  "nothing else",
  "bye",
  "eso es todo",
  "eso seria todo",
  "eso era todo",
  "es todo",
  "nada mas",
  "hasta luego",
  "hasta pronto",
  "hasta manana",
  "nos vemos",
  "hablamos luego",
  "adios",
  "chao",
  "chau",
  "termina la llamada",
  "corta la llamada",
  "cuelga",
  "ya termine",
  "ya terminamos",
];

const filler = FILLER.join("|");
// Whole-utterance only: a closing phrase alone, give or take filler on either side.
const FAREWELL = new RegExp(`^(?:(?:${filler}) )*(?:${CLOSING.join("|")})(?: (?:${filler}))*$`);
const MAX_WORDS = 8;

/** True when the whole utterance is the caller saying goodbye, not a sentence mentioning one. */
export function isFarewell(text: string): boolean {
  // "¿Eso es todo?" asks whether the call is over.
  if (/[?¿]/.test(text)) return false;
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > MAX_WORDS) return false;
  return FAREWELL.test(words.join(" "));
}
