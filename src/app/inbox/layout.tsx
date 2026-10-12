import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Inbox",
  description:
    "Your Dirac inbox: letters sealed to your ML-KEM-768 passport key, opened in your browser. The server keeps ciphertext and cannot read them.",
  alternates: { canonical: "/inbox" },
};

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return children;
}
