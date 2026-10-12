"use client";

/**
 * /lab: the attack lab. Static export, entirely client-side, no Worker
 * calls. Left: the chapter header and the table of contents. Right: five
 * exhibits, each a panel. Toy sizes, real algorithms, honest copy.
 */

import { useEffect, useRef } from "react";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";
import { LabContents } from "@/components/lab/Exhibit";
import HarvestNow from "@/components/lab/HarvestNow";
import Lattice from "@/components/lab/Lattice";
import ShorWalkthrough from "@/components/lab/ShorWalkthrough";
import ToyKeyCrack from "@/components/lab/ToyKeyCrack";
import WorkFactor from "@/components/lab/WorkFactor";

export default function LabPage() {
  return (
    <>
      <Nav />
      <main className="relative z-10 mx-auto max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <Lab />
      </main>
      <Footer />
    </>
  );
}

/** The sticky column's preferred offset, lg:top-28. */
const STICKY_TOP = 112;
/** Room kept under the column when it is pinned higher to fit. */
const STICKY_BOTTOM = 24;
const STICKY_MIN_TOP = 16;

/**
 * On short desktop screens (1366x768, 1280x800) the header plus the contents
 * is taller than the space under a 112 px offset and its last lines stayed
 * cut off by the bottom of the window. Pin it higher instead, just enough for
 * the whole column to fit.
 */
function useFitSticky() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const top = Math.max(STICKY_MIN_TOP, Math.min(STICKY_TOP, window.innerHeight - el.offsetHeight - STICKY_BOTTOM));
      el.style.top = `${top}px`;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);
  return ref;
}

function Lab() {
  const sticky = useFitSticky();
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-16">
      <div>
        <div ref={sticky} className="lg:sticky lg:top-28">
          <ChapterHeader
            as="h1"
            index={5}
            eyebrow="Attack lab"
            meta="toy sizes · real algorithms"
            title={
              <>
                Break it
                <br />
                <span className="display-serif text-paper-2">yourself.</span>
              </>
            }
            lede="Five exhibits. The keys are toy-sized so this tab can break them before you scroll; the algorithms, the arithmetic and the post-quantum library are the real ones. Nothing here touches your wallet."
          />
          <LabContents className="mt-10" />
          <p className="mt-6 max-w-md text-xs leading-relaxed text-mute">
            Everything runs in your browser. Where a number comes from a paper it says so; where a reveal is
            staged it says so.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <ToyKeyCrack />
        <ShorWalkthrough />
        <WorkFactor />
        <Lattice />
        <HarvestNow />
      </div>
    </div>
  );
}
