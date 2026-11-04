"use client";

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLowPerformanceMode } from "../lib/performanceMode";
import SiteDialogFrame from "./SiteDialogFrame";

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.3, ease: "easeOut" },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.2, ease: "easeIn" },
  },
};

const modalContainerVariants = {
  hidden: { opacity: 0, scale: 0.95, y: 15 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: "spring",
      damping: 25,
      stiffness: 300,
      mass: 0.8,
      staggerChildren: 0.08,
      delayChildren: 0.1,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 15,
    transition: { duration: 0.2 },
  },
};

const lowPerformanceVariants = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.16, ease: "easeOut" },
  },
  exit: {
    opacity: 0,
    y: 6,
    transition: { duration: 0.12, ease: "easeIn" },
  },
};

const animatePresence = (content) => <AnimatePresence>{content}</AnimatePresence>;

export default function SiteDialog(props) {
  const lowPerformanceMode = useLowPerformanceMode();

  return (
    <SiteDialogFrame
      {...props}
      overlay={motion.div}
      overlayProps={{ animate: "visible", exit: "exit", initial: "hidden", variants: overlayVariants }}
      panel={motion.div}
      panelProps={{
        animate: "visible",
        exit: "exit",
        initial: "hidden",
        variants: lowPerformanceMode ? lowPerformanceVariants : modalContainerVariants,
      }}
      presence={animatePresence}
    />
  );
}
