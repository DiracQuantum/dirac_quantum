import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Qubit arena",
  description:
    "Build a two-qubit fighter from H, X, Z and RY gates. Ranked bouts and a daily round-robin tournament are commit-reveal, sealed with your passport and decided by the exact wavefunction; daily challenges and sparring follow the quantum pet's collapse.",
  alternates: { canonical: "/arena" },
};

export default function ArenaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
