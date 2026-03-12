import Footer from "../components/Footer";
import PackagesComp from "../components/Packages";
export default function Packages({ initialData = null }) {
  return (
    <>
      <PackagesComp
        initialPackages={initialData?.packagesList || null}
        initialSectionCopy={initialData?.packagesSettings || null}
      />
      <Footer />
    </>
  );
}
