import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Attack lab",
  description:
    "Break it yourself: brute-force a toy key, step through Shor on 15, price the same attack on a lattice key, round a lattice, and open a harvested envelope on Q-Day. Toy sizes, real algorithms.",
  alternates: { canonical: "/lab" },
};

export default function LabLayout({ children }: { children: React.ReactNode }) {
  return children;
}
