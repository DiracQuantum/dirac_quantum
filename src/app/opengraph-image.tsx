import { ImageResponse } from "next/og";

/**
 * Default social card (1200x630), rendered at build time by the static export.
 * Per-report, per-passport and per-day cards are drawn in the browser and
 * stored by the Worker (worker/share.ts); the Worker swaps the og:image tag
 * to those when they exist, otherwise this image is what X and Telegram show.
 */

export const dynamic = "force-static";
export const alt = "Dirac: identity that survives Q-Day";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#070708";
const PAPER = "#f2f1ec";
const MUTE = "#8c8c87";
const SIGNAL = "#4d8bff";

/**
 * Every string the card sets in each face. The Google Fonts request below
 * asks for exactly these glyphs (`text=`), so a character missing here would
 * fall back to another font for that one letter; keep the lists in step with
 * the markup.
 */
const WORDMARK = "DIRAC";
const EYEBROW = "POST-QUANTUM IDENTITY FOR SOLANA";
const HEADLINE = ["Identity", "Q-Day."] as const;
const SERIF_LINE = "that survives";
const FOOTER_LABELS = ["ML-KEM-768", "ML-DSA-65", "MEMO ANCHOR"] as const;
const DOMAIN = "dirac.digital";

/** The distinct characters of several strings, for the `text=` subset parameter. */
const glyphs = (...parts: readonly string[]): string => Array.from(new Set(parts.join(""))).join("");

const ARCHIVO_TEXT = glyphs(WORDMARK, EYEBROW, ...HEADLINE, ...FOOTER_LABELS, DOMAIN);
const NEWSREADER_TEXT = glyphs(SERIF_LINE);

/** Google Fonts serves TTF when no browser user agent is sent; satori needs TTF/OTF. */
async function googleFont(family: string, text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=${family}&text=${encodeURIComponent(text)}`)
    ).text();
    const m = css.match(/src: url\((.+?)\) format\('(opentype|truetype)'\)/);
    if (!m) return null;
    const res = await fetch(m[1]);
    return res.ok ? res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** Deterministic scatter of dots: a lattice with a little jitter, no randomness at render. */
function dots(): { x: number; y: number; r: number; a: number }[] {
  const out: { x: number; y: number; r: number; a: number }[] = [];
  for (let i = 0; i < 14; i++) {
    for (let j = 0; j < 8; j++) {
      const h = ((i * 73 + j * 151) % 97) / 97;
      const g = ((i * 31 + j * 17) % 89) / 89;
      out.push({
        x: 700 + i * 36 + (h - 0.5) * 22,
        y: 90 + j * 46 + (g - 0.5) * 26,
        r: 1.5 + h * 3,
        a: 0.25 + g * 0.6,
      });
    }
  }
  return out;
}

export default async function Image() {
  const [archivo, newsreader] = await Promise.all([
    googleFont("Archivo:wght@700", ARCHIVO_TEXT),
    googleFont("Newsreader:ital,wght@1,400", NEWSREADER_TEXT),
  ]);
  const fonts = [
    archivo ? { name: "Archivo", data: archivo, weight: 700 as const, style: "normal" as const } : null,
    newsreader ? { name: "Newsreader", data: newsreader, weight: 400 as const, style: "italic" as const } : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          color: PAPER,
          padding: "64px 72px",
          fontFamily: archivo ? "Archivo" : "sans-serif",
          position: "relative",
        }}
      >
        {dots().map((d, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: d.x,
              top: d.y,
              width: d.r * 2,
              height: d.r * 2,
              borderRadius: 999,
              background: i % 5 === 0 ? SIGNAL : PAPER,
              opacity: d.a,
            }}
          />
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 0,
              height: 0,
              borderTop: "14px solid transparent",
              borderBottom: "14px solid transparent",
              borderLeft: `22px solid ${PAPER}`,
            }}
          />
          <div style={{ fontSize: 30, letterSpacing: 6, fontWeight: 700 }}>{WORDMARK}</div>
          <div style={{ fontSize: 22, color: MUTE, marginLeft: 18, letterSpacing: 2 }}>{EYEBROW}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 128, lineHeight: 0.92, fontWeight: 700, letterSpacing: -5 }}>{HEADLINE[0]}</div>
          <div
            style={{
              fontSize: 118,
              lineHeight: 0.96,
              fontFamily: newsreader ? "Newsreader" : "serif",
              fontStyle: "italic",
              color: "#d9d7cf",
              letterSpacing: -3,
            }}
          >
            {SERIF_LINE}
          </div>
          <div style={{ fontSize: 128, lineHeight: 0.92, fontWeight: 700, letterSpacing: -5 }}>{HEADLINE[1]}</div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: MUTE, letterSpacing: 2 }}>
          <div style={{ display: "flex", gap: 28 }}>
            {FOOTER_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
          <span style={{ color: PAPER }}>{DOMAIN}</span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
