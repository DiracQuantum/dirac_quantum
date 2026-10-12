"use client";

import { useMotionValueEvent, useScroll } from "framer-motion";
import { useEffect, useRef, useState } from "react";

type Props = {
  /** Total scroll distance the stage stays pinned for. */
  height?: string;
  className?: string;
  children: (progress: number) => React.ReactNode;
};

/**
 * A chapter that pins to the viewport while the page scrolls through `height`,
 * handing its children a 0..1 progress value to drive the sequence.
 *
 * A stage taller than the viewport (phones and tablets, where the two columns
 * stack) pins by its bottom edge instead of its top: the page first scrolls
 * the stage up to its end, then holds it there, so the card at the bottom is
 * on screen while its sequence plays instead of animating below the fold.
 *
 * The sections that wrap a stage carry no scroll margin: an anchor jump (the
 * hero's Scroll button, the nav) lands on the pin itself, with the stage
 * centred, not 100px short of it with the card cut by the fold.
 */
export default function Pinned({ height = "260vh", className = "", children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });
  const [p, setP] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (v) => setP(v));

  // sticky offset: 0 when the stage fits, negative (viewport minus stage) when it does not
  const [top, setTop] = useState(0);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setTop(Math.min(0, Math.round(window.innerHeight - el.offsetHeight)));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // on a phone the toolbar and the keyboard change only the height while the
    // visitor scrolls or types: re-pinning then would jump the stage, so touch
    // screens re-measure on a width change (rotation) only
    const touch = window.matchMedia("(pointer: coarse)").matches;
    let width = window.innerWidth;
    const onResize = () => {
      if (touch && window.innerWidth === width) return;
      width = window.innerWidth;
      measure();
    };
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div ref={ref} style={{ height }} className={`relative ${className}`}>
      <div
        ref={stage}
        style={{ top }}
        className="sticky top-0 flex min-h-screen items-center overflow-hidden"
      >
        <div className="w-full">{children(p)}</div>
      </div>
    </div>
  );
}
