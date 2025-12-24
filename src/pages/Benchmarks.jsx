import Userbenchmarks from "../components/Benchmarks";
import Footer from "../components/Footer";
import SEO from "../components/SEO";

export default function Benchmarks() {
  return (
    <>
      <SEO
        title="Benchmark Results | Roo Industries"
        description="See real before-and-after FPS gains from Roo Industries optimizations."
      />
      {<Userbenchmarks />}
      {<Footer />}
    </>
  );
}
