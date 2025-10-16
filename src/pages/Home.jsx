import Hero from "../components/Hero";
import About from "../components/About";
import Services from "../components/Services";
import Reviews from "../components/Reviews";
import Footer from "../components/Footer";

export default function Home() {
  return (
    <>
      <Hero />
      {<About />}
      {<Services />}
      {<Reviews />}
      {<Footer />}
    </>
  );
}
