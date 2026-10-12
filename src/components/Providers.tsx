"use client";

import { MotionConfig } from "framer-motion";
import { SessionProvider } from "@/components/app/session";
import { useMotionForced } from "@/lib/motion";
import { WalletProvider } from "@/lib/solana/wallet";

export default function Providers({ children }: { children: React.ReactNode }) {
  const forced = useMotionForced();
  return (
    <MotionConfig reducedMotion={forced ? "never" : "user"}>
      <WalletProvider>
        <SessionProvider>{children}</SessionProvider>
      </WalletProvider>
    </MotionConfig>
  );
}
