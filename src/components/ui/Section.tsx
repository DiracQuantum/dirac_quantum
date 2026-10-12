type HeaderProps = {
  index: number;
  eyebrow: string;
  meta?: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  className?: string;
  /** Heading level. App pages pass "h1" (one per page); landing chapters keep the default "h2". */
  as?: "h1" | "h2";
};

/** Chapter header: number and label on a rule, then the display title. */
export function ChapterHeader({ index, eyebrow, meta, title, lede, className = "", as: Heading = "h2" }: HeaderProps) {
  return (
    <header className={className}>
      <div className="flex items-center justify-between gap-6 border-t border-line pt-4">
        <span className="eyebrow tnum">{String(index).padStart(2, "0")} / {eyebrow}</span>
        {meta ? <span className="eyebrow hidden sm:inline">{meta}</span> : null}
      </div>
      <Heading className="display mt-8 text-[clamp(2.6rem,6.2vw,5.6rem)]">{title}</Heading>
      {lede ? (
        <p className="mt-6 max-w-md text-base leading-relaxed text-mute md:text-lg">{lede}</p>
      ) : null}
    </header>
  );
}

type SectionProps = {
  id: string;
  index: number;
  children: React.ReactNode;
  className?: string;
};

/** Plain (non-pinned) chapter wrapper with the scene index for the 3D background. */
export default function Section({ id, index, children, className = "" }: SectionProps) {
  return (
    <section
      id={id}
      data-scene={index}
      className={`relative scroll-mt-24 py-24 md:py-36 ${className}`}
    >
      <div className="mx-auto max-w-[1400px] px-5 md:px-8">{children}</div>
    </section>
  );
}
