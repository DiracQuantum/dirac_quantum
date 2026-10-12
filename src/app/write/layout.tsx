import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Write",
  description:
    "Write to a Dirac passport: the letter is encrypted in your browser with the recipient's ML-KEM-768 key. The server stores ciphertext and the sender's signature, nothing else.",
  alternates: { canonical: "/write" },
};

export default function WriteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
