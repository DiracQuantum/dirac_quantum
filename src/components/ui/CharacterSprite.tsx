"use client";

import Image from "next/image";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useState } from "react";

type Props = {
  src: string;
  alt: string;
  label: string;
  className?: string;
  flip?: boolean;
  /** Mouse tilt strength in degrees. 0 disables. */
  tilt?: number;
};

/**
 * Character image from /public/characters, rendered on a black background.
 * The parent that places it on a dark panel applies `mix-blend-screen`, which
 * makes the black vanish. The blend must sit on the outermost transformed
 * wrapper, because any transform or perspective isolates the blend group.
 * Tilts towards the cursor to give the flat render some depth.
 * Until a file exists, shows a quiet placeholder with the expected filename.
 */
export default function CharacterSprite({
  src,
  alt,
  label,
  className = "",
  flip = false,
  tilt = 10,
}: Props) {
  const [missing, setMissing] = useState(false);
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const rx = useSpring(useTransform(my, [0, 1], [tilt, -tilt]), { stiffness: 120, damping: 18 });
  const ry = useSpring(useTransform(mx, [0, 1], [-tilt, tilt]), { stiffness: 120, damping: 18 });

  return (
    <motion.div
      className={`relative ${className}`}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        mx.set((e.clientX - r.left) / r.width);
        my.set((e.clientY - r.top) / r.height);
      }}
      onPointerLeave={() => {
        mx.set(0.5);
        my.set(0.5);
      }}
    >
      {!missing ? (
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized
          sizes="(max-width: 768px) 60vw, 320px"
          draggable={false}
          className={`select-none object-contain ${flip ? "-scale-x-100" : ""}`}
          style={{ WebkitUserDrag: "none" } as React.CSSProperties}
          onError={() => setMissing(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-end justify-center">
          <div className="relative flex h-[82%] w-[70%] items-end justify-center">
            <div className="absolute inset-x-[12%] top-0 bottom-[18%] rounded-[45%_45%_40%_40%/55%_55%_35%_35%] border border-line bg-gradient-to-b from-paper/10 to-paper/0" />
            <div className="absolute inset-x-[30%] top-[-6%] aspect-square rounded-full border border-line bg-paper/10" />
            <span className="relative z-10 mb-2 rounded-full border border-line bg-ink/80 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
              {label}
            </span>
          </div>
        </div>
      )}
    </motion.div>
  );
}
