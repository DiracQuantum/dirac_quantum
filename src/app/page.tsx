import Nav from "@/components/ui/Nav";
import Hero from "@/components/sections/Hero";
import Scanner from "@/components/sections/Scanner";
import Passport from "@/components/sections/Passport";
import Seal from "@/components/sections/Seal";
import Inbox from "@/components/sections/Inbox";
import Playground from "@/components/sections/Playground";
import Token from "@/components/sections/Token";
import Footer from "@/components/sections/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="relative z-10">
        <Hero />
        <Scanner />
        <Passport />
        <Seal />
        <Inbox />
        <Playground />
        <Token />
      </main>
      <Footer />
    </>
  );
}
