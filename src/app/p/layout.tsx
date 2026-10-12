import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Public passport",
  description:
    "The public record of a Dirac passport: its post-quantum keys, self-signature, wallet signature and the Solana transaction that anchors it.",
  // worker/html.ts swaps this for /p?a=<wallet> when the query names a valid wallet.
  alternates: { canonical: "/p" },
};

export default function PublicPassportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
