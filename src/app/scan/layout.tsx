import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scan",
  description:
    "Scan any Solana address: what one Ed25519 key can move today, the post-quantum identity bound to it, and how complete the read was.",
  // worker/html.ts swaps this for /scan?a=<wallet> when the query names a valid wallet.
  alternates: { canonical: "/scan" },
};

export default function ScanLayout({ children }: { children: React.ReactNode }) {
  return children;
}
