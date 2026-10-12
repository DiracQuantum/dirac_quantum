import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Seal",
  description:
    "Sign a text or a file with ML-DSA-65 and verify any .qseal. The document stays on your device; only its hash is signed and checked.",
  alternates: { canonical: "/seal" },
};

export default function SealLayout({ children }: { children: React.ReactNode }) {
  return children;
}
