import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Passport",
  description:
    "Issue a post-quantum passport for a Solana wallet: ML-KEM-768 and ML-DSA-65 keys bound to the wallet, anchored on chain with one memo.",
  alternates: { canonical: "/passport" },
};

export default function PassportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
