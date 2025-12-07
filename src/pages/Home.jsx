import Hero from "../components/Hero";
import About from "../components/About";
import Services from "../components/Services";
import StreamerYoutuberReviews from "../components/StreamerYoutuberReviews";
import Footer from "../components/Footer";
import HowItWorks from "../components/HowItWorks";
export default function Home() {
  return (
    <>
      <Hero />
      <About />
      <StreamerYoutuberReviews />
      <Services />
      <HowItWorks />
      <Footer />
    </>
  );
}
