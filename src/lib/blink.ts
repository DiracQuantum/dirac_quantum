/**
 * Links for the "Invite to Dirac" Blink (worker/actions.ts).
 *
 * `/invite/<wallet>` is the URL to share: X and Blink-aware wallets map it
 * through /actions.json to `/api/actions/invite/<wallet>` and render a
 * "Send invite" button; a visitor without a Blink client is redirected by
 * the Worker to `/write?to=<wallet>`, the site's own invite flow.
 *
 * Pure module: no React, no DOM apart from what `siteOrigin` reads. Call
 * these from handlers or effects, like the other share links; during the
 * static export `siteOrigin()` is empty and the result is a relative path,
 * which is still a valid href on the site itself.
 */

import { siteOrigin } from "@/lib/share";

/** Path of the shareable link for one wallet. */
export const INVITE_BLINK_PATH = (wallet: string): string => `/invite/${encodeURIComponent(wallet)}`;

/** `https://dirac.digital/invite/<wallet>`: the link to post on X or send to a friend. */
export function inviteBlinkUrl(wallet: string, origin: string = siteOrigin()): string {
  return `${origin.replace(/\/+$/, "")}${INVITE_BLINK_PATH(wallet)}`;
}
