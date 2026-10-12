"use client";

import { useEffect, useRef, useState } from "react";
import { startIntro, subscribeIntro, useIntroStarted } from "@/lib/introStore";
import { motionReduced, useMotionForced } from "@/lib/motion";

/** Lifetime of the overlay once the burst starts (matches the particle timeline). */
const INTRO_MS = 2700;
/**
 * If the scene has not drawn its first frame by then (slow WebGL start, slow
 * chunk, no WebGL), the flash starts anyway instead of holding a black screen;
 * the particles join with their own burst when they are ready.
 */
const FALLBACK_MS = 2500;

/**
 * The first thing a visitor sees: black, then a point of light gathers,
 * detonates into a ring and a white flash, and fades while the particle
 * lattice settles behind it. Pure CSS, removed from the DOM when done. The
 * clock is shared with the scene (introStore). Skipped under reduced motion
 * unless the page is opened with ?motion=force.
 */
export default function IntroFlash() {
  const forced = useMotionForced();
  const started = useIntroStarted();
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Flip the class straight on the DOM when the clock starts, so the flash
  // never waits for a React commit (React renders the same class afterwards).
  useEffect(
    () =>
      subscribeIntro(() => {
        const el = ref.current;
        if (!el) return;
        el.classList.remove("intro-flash--wait");
        el.classList.add("intro-flash--live");
      }),
    [],
  );

  useEffect(() => {
    const id = window.setTimeout(startIntro, motionReduced() ? 0 : FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!started) return;
    const id = window.setTimeout(() => setDone(true), motionReduced() ? 0 : INTRO_MS);
    return () => window.clearTimeout(id);
  }, [started]);

  if (done) return null;
  const cls = [
    "intro-flash",
    started ? "intro-flash--live" : "intro-flash--wait",
    forced ? "intro-flash--forced" : "",
  ].join(" ");
  return (
    <div ref={ref} aria-hidden className={cls}>
      <span className="intro-flash__core" />
      <span className="intro-flash__ring" />
      <span className="intro-flash__ring intro-flash__ring--2" />
    </div>
  );
}
