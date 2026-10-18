import Footer from "../components/Footer";
import PackagesComp from "../components/Packages";
export default function Packages({ initialData = null }) {
  return (
    <>
      <h1 className="sr-only">PC Game Optimization Packages</h1>
      <PackagesComp initialPackages={initialData?.packagesList ?? null} initialSectionCopy={initialData?.packagesSettings ?? null} />
      <Footer />
    </>
  );
}
