import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quantum pet",
  description:
    "One shared 10-qubit register. Apply a gate, change tonight's odds; at 00:00 UTC it collapses into a new form, character, ability and palette.",
  alternates: { canonical: "/pet" },
};

export default function PetLayout({ children }: { children: React.ReactNode }) {
  return children;
}
