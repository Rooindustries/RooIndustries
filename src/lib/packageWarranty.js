import { Shield, ShieldCheck } from "lucide-react";
import packageContent from "./packageContent";

const { buildPackageOffer } = packageContent;

export const getWarrantyCallout = (pkg) => {
  const offer = pkg?.warranty ? pkg : buildPackageOffer(pkg);
  return {
    ...offer.warranty,
    Icon: offer.isTopPackage ? ShieldCheck : Shield,
  };
};
