import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, Newsreader } from "next/font/google";
import "./globals.css";
import SmoothScroll from "@/components/scroll/SmoothScroll";
import SceneLoader from "@/components/three/SceneLoader";
import Providers from "@/components/Providers";
import IntroFlash from "@/components/ui/IntroFlash";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://dirac.digital"),
  title: { default: "Dirac · Post-quantum identity for Solana", template: "%s · Dirac" },
  description:
    "Post-quantum passports, seals and encrypted inboxes for Solana wallets. Anchored on-chain, before Q-Day.",
  // The landing page's canonical. Every route layout sets its own; worker/html.ts
  // points /scan?a= and /p?a= at the scanned or public wallet.
  alternates: { canonical: "/" },
  openGraph: { siteName: "Dirac", type: "website" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexMono.variable} ${newsreader.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-ink text-paper">
        <Providers>
          <SmoothScroll />
          <SceneLoader />
          <IntroFlash />
          <div className="grain" aria-hidden />
          {children}
        </Providers>
      </body>
    </html>
  );
}
