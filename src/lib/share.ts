/**
 * Share cards: the browser draws a 1200×630 PNG for a report, a passport or
 * a pet day and hands it to the Worker (`PUT /api/share/<kind>/<id>`), which
 * stores it and points the page's og:image at it (worker/share.ts). A link
 * pasted into X or Telegram then previews that card instead of the generic
 * site image.
 *
 * Uploads are fire and forget: `uploadShareCard` never throws and a failure
 * changes nothing on the page. The Worker accepts uploads from the site's
 * own origin only (so a page served by `next dev` against a remote API
 * cannot store cards), refuses anything but a 1200×630 PNG under 160 KB,
 * takes six uploads per minute per client and keeps a stored card for ten
 * minutes before an upload may replace it. A passport's card is stored once
 * per registered passport; only its wallet replaces it, by signing
 * SHARE_MESSAGE over the PNG (`signShareCard`). A pet card is stored for the
 * current day only, a scan card right after a complete scan.
 */

import { base64 } from "@scure/base";
import { API_BASE } from "@/lib/api";

export type ShareKind = "scan" | "passport" | "pet";

/** The Worker's cap; a larger blob is not even sent. */
export const MAX_SHARE_BYTES = 160 * 1024;
const ED25519_SIG_LEN = 64;

/** Message a passport's wallet signs to replace its stored card (the Worker checks the same string, worker/share.ts). */
export const SHARE_MESSAGE = (wallet: string, pngSha256Hex: string): string => `share:passport:${wallet}:${pngSha256Hex}`;

/** The part of a connected wallet the signing needs (`ConnectedWallet` from lib/solana/wallet fits). */
export interface ShareSigner {
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Stores a drawn card under its key. Resolves true when the Worker accepted
 * it, false on any failure (network, 4xx, 5xx, a blob over the cap). `sig`
 * is the wallet's signature from `signShareCard`, for a passport card the
 * wallet replaces.
 */
export async function uploadShareCard(kind: ShareKind, id: string, png: Blob, sig?: string): Promise<boolean> {
  if (png.size === 0 || png.size > MAX_SHARE_BYTES) return false;
  try {
    const headers: Record<string, string> = { "Content-Type": "image/png" };
    if (sig) headers["X-Share-Sig"] = sig;
    const res = await fetch(`${API_BASE}/api/share/${kind}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers,
      body: png,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** hex sha256 of a blob (WebCrypto). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The wallet's base64 Ed25519 signature over SHARE_MESSAGE for this PNG.
 * Throws whatever the wallet throws (a refusal included).
 */
export async function signShareCard(signer: ShareSigner, png: Blob): Promise<string> {
  const message = new TextEncoder().encode(SHARE_MESSAGE(signer.address, await sha256Hex(png)));
  const sig = await signer.signMessage(message);
  if (!(sig instanceof Uint8Array) || sig.length !== ED25519_SIG_LEN) {
    throw new Error("The wallet returned something that is not an Ed25519 signature.");
  }
  return base64.encode(sig);
}

/** The canvas as a PNG blob. */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not render the card."));
    }, "image/png");
  });
}

/** Saves a blob through a temporary download link. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The site origin for share links: `NEXT_PUBLIC_SITE_URL` when set, otherwise
 * the origin of the current page. Call it from handlers or effects only.
 */
export function siteOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** "dirac.network" from "https://dirac.network" */
export function hostOf(origin: string): string {
  return origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

/** The X intent URL for a post; `url` is appended by X after the text. */
export function xIntent(text: string, url?: string): string {
  const query = `text=${encodeURIComponent(text)}${url ? `&url=${encodeURIComponent(url)}` : ""}`;
  return `https://x.com/intent/post?${query}`;
}
