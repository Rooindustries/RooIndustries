import React from "react";
import { motion } from "framer-motion";
import PriceDisplay from "./PriceDisplay";
import SiteDialog from "./SiteDialog";
import packageContent from "../lib/packageContent";

const { getPackageFeatureItems } = packageContent;

const itemVariants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 200, damping: 20 },
  },
};

export default function PackageDetailsModal({
  open,
  onClose,
  pkg,
  renderFeature,
}) {
  const featureItems = getPackageFeatureItems(pkg);
  const tagText = pkg?.tag || "Roo Industries Package";

  return (
    <SiteDialog
      ariaLabelledBy="package-details-modal-title"
      onClose={onClose}
      open={open}
    >
      <motion.div variants={itemVariants}>
        <div className="inline-flex items-center px-4 py-1.5 rounded-full text-xs font-semibold text-accent-contrast bg-info shadow-info-soft mb-4">
          {tagText}
        </div>
      </motion.div>

      <motion.h3
        id="package-details-modal-title"
        variants={itemVariants}
        className="text-2xl font-bold text-info-text"
      >
        {pkg?.title}
      </motion.h3>

      <motion.div variants={itemVariants} className="mt-2">
        <PriceDisplay pkg={pkg} size="modal" />
      </motion.div>

      <motion.ul className="mt-4 space-y-2 text-sm text-info-text text-left">
        {featureItems.map((item, i) => (
          <motion.li
            key={`${item.label}-${i}`}
            variants={itemVariants}
            className={`flex items-start gap-2 ${
              item.included === false ? "opacity-40" : ""
            }`}
            aria-label={`${item.label}: ${
              item.included ? "included" : "not included"
            }`}
          >
            <span className="text-accent mt-1" aria-hidden="true">
              {item.included ? "\u2713" : "\u25CB"}
            </span>
            <span className="flex-1">
              {renderFeature ? renderFeature(item.label) : item.label}
            </span>
          </motion.li>
        ))}
      </motion.ul>
    </SiteDialog>
  );
}
