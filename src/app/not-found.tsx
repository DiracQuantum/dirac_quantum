import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";

export const metadata: Metadata = {
  title: "Not found",
  description: "There is no page at this address.",
  // no canonical: the 404 must not inherit the root's "/" next to its noindex
  alternates: { canonical: null },
};

/** Any unmatched URL (and the static export's 404.html): the site's own chrome, not the framework default. */
export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="relative z-10 mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <ChapterHeader
          as="h1"
          index={404}
          eyebrow="Not found"
          meta="Nothing is signed at this address"
          title={
            <>
              No page
              <br />
              <span className="display-serif text-paper-2">under this key.</span>
            </>
          }
          lede="The link is mistyped, or the page moved. Start from the landing page or scan a wallet."
        />
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Link href="/" className="pill">
            Back home
          </Link>
          <Link href="/scan" className="pill pill-ghost">
            Scan a wallet
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
