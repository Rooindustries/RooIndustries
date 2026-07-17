import React from "react";
import { motion } from "framer-motion";
import PriceDisplay from "./PriceDisplay";
import SiteDialog from "./SiteDialog";

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
  const rawFeatures = Array.isArray(pkg?.features) ? pkg.features : [];
  const normalizedFeatures = rawFeatures
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.label === "string") return item.label.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      if (item && typeof item.title === "string") return item.title.trim();
      return "";
    })
    .filter(Boolean);

  const fallbackChecklist = Array.isArray(pkg?.featureChecklist)
    ? pkg.featureChecklist
        .map((item) => {
          if (!item) return null;
          if (typeof item === "string") {
            return { label: item.trim(), included: true };
          }
          const label =
            typeof item.label === "string"
              ? item.label.trim()
              : typeof item.text === "string"
              ? item.text.trim()
              : typeof item.title === "string"
              ? item.title.trim()
              : "";
          if (!label) return null;
          const included =
            typeof item.included === "boolean" ? item.included : true;
          return { label, included };
        })
        .filter(Boolean)
    : [];

  const featureItems = normalizedFeatures.length
    ? normalizedFeatures.map((label) => ({ label, included: true }))
    : fallbackChecklist;
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
          >
            <span className="text-accent mt-1">&#10004;</span>
            <span className="flex-1">
              {renderFeature ? renderFeature(item.label) : item.label}
            </span>
          </motion.li>
        ))}
      </motion.ul>
    </SiteDialog>
  );
}
