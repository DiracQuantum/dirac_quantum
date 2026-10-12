"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { scrollState } from "@/lib/scrollStore";

export default function SmoothScroll() {
  useEffect(() => {
    const lenis = new Lenis({
      lerp: 0.09,
      smoothWheel: true,
      anchors: { offset: -16 },
      // A link to another page stops a running glide first; otherwise the glide keeps writing
      // the old scroll position and the next page opens scrolled down instead of at its top.
      stopInertiaOnNavigate: true,
    });

    lenis.on("scroll", (instance: Lenis) => {
      scrollState.velocity = instance.velocity;
      scrollState.progress = instance.progress;
    });

    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);

  return null;
}
