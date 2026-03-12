import Userbenchmarks from "../components/Benchmarks";
import Footer from "../components/Footer";

export default function Benchmarks({ initialData = null }) {
  return (
    <>
      {<Userbenchmarks initialData={initialData} />}
      {<Footer />}
    </>
  );
}
