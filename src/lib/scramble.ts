const GLYPHS = "⟨⟩|01ψφ∑∆λ∞≠≈#%&@*+-=<>/\\";

function seeded(i: number) {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Replace a share of characters with quantum-looking glyphs.
 * amount: 0 = clean text, 1 = full noise. tick changes which glyphs show.
 * Deterministic for a given (text, amount, tick), so SSR and client agree.
 */
export function scramble(text: string, amount: number, tick: number) {
  if (amount <= 0) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\n") {
      out += ch;
      continue;
    }
    if (seeded(i + 1) < amount) {
      const g = GLYPHS[Math.floor(seeded(i * 7 + tick * 13 + 3) * GLYPHS.length)];
      out += g;
    } else {
      out += ch;
    }
  }
  return out;
}
