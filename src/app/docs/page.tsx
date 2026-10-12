import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import Nav from "@/components/ui/Nav";
import Footer from "@/components/sections/Footer";
import { ChapterHeader } from "@/components/ui/Section";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Your guide to Dirac: scan a Solana wallet, create and recover a post-quantum passport, seal documents, send encrypted letters, and explore the quantum playground.",
  alternates: { canonical: "/docs" },
};

const contents = [
  ["start", "Start here"],
  ["scanner", "Read your scan"],
  ["passport", "Create a passport"],
  ["recovery", "Restore your keys"],
  ["seals", "Seal & verify"],
  ["inbox", "Send & receive"],
  ["playground", "Explore the playground"],
  ["questions", "Common questions"],
] as const;

const questions = [
  {
    question: "Do I need a wallet to try Dirac?",
    answer:
      "You can scan a public address, inspect a public passport, verify a seal, and explore the attack lab without connecting a wallet. Creating a passport, signing requests, and sending letters require a connected wallet.",
  },
  {
    question: "Which actions require SOL?",
    answer:
      "Scanning and reading public pages do not submit transactions. Anchoring a passport and sending an on-chain invite require SOL. An optional USDC payment also uses a Solana transaction and may require token-account rent. Review the transaction in your wallet before approving it.",
  },
  {
    question: "Why do I need to restore my keys after a reload?",
    answer:
      "Your secret passport keys live in memory. The browser can remember the public passport, but reloading clears the secret keys. Restore them on the Passport page with a wallet signature in Simple mode, or your phrase or recovery file in Hardened mode.",
  },
  {
    question: "Can Dirac recover a lost Hardened phrase?",
    answer:
      "No. Recovery needs the 24-word phrase or the encrypted recovery file and its password. Your wallet signature cannot recreate independent Hardened keys. Without a working backup or an existing session holding the keys, the registered passport cannot be replaced.",
  },
  {
    question: "Does a passport make my wallet balances quantum-safe?",
    answer:
      "A passport adds keys for application identity, document signatures, and encrypted messages. Solana transactions still use the network's existing signatures. Simple passport keys also derive from a wallet signature; Hardened keys are generated independently.",
  },
  {
    question: "What does a verified anchor prove?",
    answer:
      "It records the passport hash in a Solana memo transaction signed by the wallet. Dirac checks the transaction before showing the anchor as verified. The block time dates that passport record; anchoring does not replace the wallet's transaction-signing scheme.",
  },
  {
    question: "Why does my scan show unavailable data?",
    answer:
      "A source may be unavailable, incomplete, or unable to answer a request. Dirac reports that gap instead of treating it as a zero balance. Read the data-confidence panel and try a new scan before relying on a partial report.",
  },
  {
    question: "Is the quantum pet running on real hardware?",
    answer:
      "Its daily state is simulated as a shared 10-qubit register. A Sunday measurement can run on IBM Quantum hardware when the integration and allowance are available. The QPU panel reports the hardware run; simulation is the fallback when hardware is unavailable.",
  },
];

function GuideSection({
  id,
  index,
  title,
  children,
}: {
  id: string;
  index: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="panel scroll-mt-28 p-6 md:p-9">
      <div className="eyebrow tnum">{String(index).padStart(2, "0")} / Guide</div>
      <h2 id={`${id}-title`} className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">
        {title}
      </h2>
      <div className="mt-6 space-y-5 text-sm leading-relaxed text-paper/80 md:text-base">
        {children}
      </div>
    </section>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-4">
      {items.map((item, index) => (
        <li key={item} className="flex gap-4">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line font-mono text-[11px] text-paper">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function ToolLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 font-medium text-paper underline decoration-paper/30 underline-offset-4 transition-colors hover:decoration-paper">
      {children} <span aria-hidden>↗</span>
    </Link>
  );
}

export default function DocsPage() {
  return (
    <>
      <Nav />
      <main className="relative z-10 mx-auto max-w-[1400px] px-5 pt-32 pb-24 md:px-8 md:pt-40">
        <ChapterHeader
          as="h1"
          index={9}
          eyebrow="Documentation"
          meta="Identity / Proof / Privacy"
          title={<>Know your keys.<br /><span className="display-serif text-paper-2">Make them yours.</span></>}
          lede="A practical guide to your Dirac identity. Start with a wallet, understand your passport, and put it to work."
        />

        <div className="mt-12 grid items-start gap-8 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-12">
          <aside className="lg:sticky lg:top-28">
            <nav aria-label="Documentation contents" className="border-t border-line pt-5">
              <div className="eyebrow">On this page</div>
              <ol className="mt-4 flex flex-wrap gap-x-5 gap-y-3 lg:flex-col lg:gap-0">
                {contents.map(([id, label], index) => (
                  <li key={id}>
                    <a href={`#${id}`} className="inline-flex items-baseline gap-3 py-1 text-sm text-mute transition-colors hover:text-paper lg:py-2">
                      <span className="font-mono text-[10px] text-mute/70">{String(index + 1).padStart(2, "0")}</span>
                      {label}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="mt-6 hidden border-t border-line pt-5 lg:block">
              <p className="text-xs leading-relaxed text-mute">Your wallet is the starting point. Your passport is the identity you build around it.</p>
              <a href="https://x.com/dirac_quantum" target="_blank" rel="noopener noreferrer" className="mt-4 inline-block text-xs text-paper underline decoration-paper/30 underline-offset-4 hover:decoration-paper">
                Follow Dirac on X ↗
              </a>
            </div>
          </aside>

          <div className="min-w-0 space-y-5">
            <section id="start" aria-labelledby="start-title" className="paper scroll-mt-28 p-6 md:p-9">
              <span className="eyebrow !text-ink/55">01 / Start here</span>
              <h2 id="start-title" className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">Your first steps.</h2>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink/70 md:text-base">Start by reading your wallet, then create an identity for documents and private conversations.</p>
              <ol className="mt-7 grid gap-5 sm:grid-cols-3">
                {[
                  ["Read", "Scan a public address. No wallet connection is needed.", "/scan", "Open scanner"],
                  ["Create", "Connect a wallet and choose how to create and recover your passport.", "/passport", "Create passport"],
                  ["Use", "Seal a document or write an encrypted letter to another passport.", "/write", "Write a letter"],
                ].map(([title, text, href, label], index) => (
                  <li key={title} className="border-t border-line-ink pt-4">
                    <span className="font-mono text-[10px] text-ink/55">0{index + 1}</span>
                    <h3 className="mt-2 text-lg font-semibold">{title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-ink/70">{text}</p>
                    <Link href={href} className="mt-4 inline-block text-xs font-semibold underline decoration-ink/30 underline-offset-4 hover:decoration-ink">{label} ↗</Link>
                  </li>
                ))}
              </ol>
            </section>

            <GuideSection id="scanner" index={2} title="Read your scan.">
              <p>Paste a Solana address into the Scanner, or connect your wallet to scan your own address. Read the three indicators together:</p>
              <dl className="space-y-4">
                {[
                  ["Quantum exposure", "The assets and authorities detected under this key, including balances, stake, and multisig memberships where the sources support them."],
                  ["Post-quantum identity", "Whether the wallet has a registered passport, its Simple or Hardened mode, and its verified anchor status."],
                  ["Data confidence", "Which sources answered and which reads were incomplete or unavailable. A missing result is not a zero balance."],
                ].map(([term, definition]) => (
                  <div key={term} className="border-l border-line pl-4">
                    <dt className="font-medium text-paper">{term}</dt>
                    <dd className="mt-1 text-mute">{definition}</dd>
                  </div>
                ))}
              </dl>
              <p>A program or multisig account can differ from a wallet that signs transactions. The report identifies the address type so you can interpret its controls correctly.</p>
              <ToolLink href="/scan">Scan a wallet</ToolLink>
            </GuideSection>

            <GuideSection id="passport" index={3} title="Create your passport.">
              <p>Your passport contains public keys for encrypted messages and post-quantum signatures, bound to your Solana wallet. Choose a recovery method before creating it.</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-line p-5">
                  <h3 className="font-semibold text-paper">Simple</h3>
                  <p className="mt-2 text-sm text-mute">Derives keys from a wallet signature. Restore them by signing the same message with the same wallet. Anyone who obtains that wallet secret can derive the same passport keys.</p>
                </div>
                <div className="rounded-xl border border-line p-5">
                  <h3 className="font-semibold text-paper">Hardened</h3>
                  <p className="mt-2 text-sm text-mute">Creates independent random keys. Save the 24-word recovery phrase and, optionally, a password-encrypted recovery file. A wallet signature alone cannot recover these keys.</p>
                </div>
              </div>
              <Steps items={[
                "Connect the wallet you want the passport to belong to.",
                "Choose Simple or Hardened. In Hardened mode, generate and save your recovery phrase before continuing.",
                "Create the passport and approve the requested wallet signatures. The passport is also signed by its own post-quantum key.",
                "Use Anchor on Solana to record the passport hash in a memo transaction. Wait for the transaction and the registry's verification.",
              ]} />
              <p>Your public passport page and badge can be shared. They contain public proof, not your secret keys or recovery phrase.</p>
              <ToolLink href="/passport">Create or view your passport</ToolLink>
            </GuideSection>

            <GuideSection id="recovery" index={4} title="Restore your keys.">
              <p>If a page remembers your passport but asks you to restore keys, the public record is present and the secret keys need to be loaded again.</p>
              <Steps items={[
                "Open Passport and connect the same wallet that owns the registered passport.",
                "For Simple mode, restore with the wallet signature. For Hardened mode, enter your 24-word phrase or import the encrypted recovery file with its password.",
                "Wait for the recovered keys to be checked against the registered passport, then return to Seal, Inbox, or Arena.",
              ]} />
              <div className="rounded-xl border border-line bg-ink p-5">
                <h3 className="font-medium text-paper">Keep your recovery method.</h3>
                <p className="mt-2 text-sm text-mute">A public passport download is not a recovery backup. Keep your Hardened phrase or encrypted recovery file securely. Dirac cannot reset independent keys from a wallet signature.</p>
              </div>
              <p>Switching modes creates a new passport version and needs a rotation signed by your existing post-quantum key. Restore the current keys before attempting a replacement.</p>
              <ToolLink href="/passport">Restore your passport</ToolLink>
            </GuideSection>

            <GuideSection id="seals" index={5} title="Seal a document. Verify a proof.">
              <p>A seal signs the hash of a text or file with your passport. The original document stays on your device.</p>
              <Steps items={[
                "Connect your wallet and restore the passport keys if needed.",
                "Open Seal, choose text or a file, and create the signature.",
                "Download the .qseal proof or share its verification link. Give the recipient the original document separately if they need to compare it.",
              ]} />
              <h3 className="text-lg font-medium text-paper">To verify</h3>
              <p>Open the verification link or load the .qseal file in the Verify panel. Add the original text or file to compare its hash. Read the signature result, passport version, and anchor status separately.</p>
              <p>Changing the document changes its hash. The .qseal contains a hash, signature, and public key; it does not contain the document itself.</p>
              <ToolLink href="/seal">Seal or verify a document</ToolLink>
            </GuideSection>

            <GuideSection id="inbox" index={6} title="Send and receive encrypted letters.">
              <Steps items={[
                "Open Write and enter the recipient's Solana wallet address.",
                "If a passport is registered, write your message and connect the sending wallet. Your browser encrypts the letter to the recipient's passport key.",
                "Approve the envelope signature and send. To receive a reply, you need a passport of your own.",
                "To read incoming letters, open Inbox, authorize the read with your wallet, and restore your passport keys when prompted.",
              ]} />
              <p>If the recipient has no passport, Write offers an on-chain invite instead. The invite uses a small SOL transfer and a memo pointing to passport creation. After they create a passport, return to Write to send your encrypted letter.</p>
              <p>You can optionally attach a USDC payment. Its transaction is public on Solana; the letter text remains encrypted. Check the amount, recipient, and fees before approving the transfer.</p>
              <p>The server stores ciphertext and routing metadata such as sender and recipient. The message is decrypted in the recipient&apos;s browser.</p>
              <div className="flex flex-wrap gap-x-6 gap-y-3">
                <ToolLink href="/write">Write a letter</ToolLink>
                <ToolLink href="/inbox">Open your inbox</ToolLink>
              </div>
            </GuideSection>

            <GuideSection id="playground" index={7} title="Learn by changing the odds.">
              <div className="space-y-6">
                {[
                  ["Quantum Pet", "Apply a gate to the shared 10-qubit register and watch its probabilities change. At 00:00 UTC, a measurement selects the next form. Signed gates can count toward participation badges. The QPU panel identifies configured IBM hardware runs and their results.", "/pet"],
                  ["Qubit Arena", "Build a circuit and try it in sparring. Ranked play uses your passport keys to sign a commitment, followed by a reveal. Ranked results use exact two-qubit probabilities; keep the browser's fighter record available until the reveal is complete.", "/arena"],
                  ["Attack Lab", "Walk through toy attacks, Shor's algorithm, lattice problems, and harvest-now-decrypt-later examples. The small demonstrations explain the concepts and do not attack a real wallet.", "/lab"],
                ].map(([title, text, href]) => (
                  <div key={href}>
                    <h3 className="text-lg font-medium text-paper">{title}</h3>
                    <p className="mt-2 text-mute">{text}</p>
                    <div className="mt-3"><ToolLink href={href}>Explore {title}</ToolLink></div>
                  </div>
                ))}
              </div>
            </GuideSection>

            <GuideSection id="questions" index={8} title="A few things worth knowing.">
              <div className="divide-y divide-line">
                {questions.map(({ question, answer }) => (
                  <details key={question} className="group py-4 first:pt-0">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-5 font-medium text-paper [&::-webkit-details-marker]:hidden">
                      {question}
                      <span aria-hidden className="shrink-0 font-mono text-lg leading-6 text-mute transition-transform group-open:rotate-45">+</span>
                    </summary>
                    <p className="mt-3 max-w-2xl pr-6 text-sm leading-relaxed text-mute">{answer}</p>
                  </details>
                ))}
              </div>
            </GuideSection>

            <div className="flex flex-col justify-between gap-5 rounded-2xl border border-line p-6 sm:flex-row sm:items-center md:p-9">
              <div>
                <div className="eyebrow">Keep exploring</div>
                <p className="mt-2 text-lg text-paper">Your identity starts with your wallet.</p>
              </div>
              <Link href="/passport" className="pill justify-center">Create passport <span aria-hidden>↗</span></Link>
            </div>
            <p className="px-1 text-xs leading-relaxed text-mute">
              Follow <a href="https://x.com/dirac_quantum" target="_blank" rel="noopener noreferrer" className="text-paper underline decoration-paper/30 underline-offset-4 hover:decoration-paper">@dirac_quantum on X</a> for updates, or explore the implementation on <a href="https://github.com/DiracQuantum/dirac_quantum" target="_blank" rel="noopener noreferrer" className="text-paper underline decoration-paper/30 underline-offset-4 hover:decoration-paper">GitHub</a>.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
