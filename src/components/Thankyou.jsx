import React from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

export default function ThankYou() {
  const containerVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] },
    },
    exit: { opacity: 0, y: -10, transition: { duration: 0.2 } },
  };

  return (
    <motion.section
      className="pt-40 text-center text-white max-w-lg mx-auto"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.h1
        className="text-4xl font-bold text-sky-300 drop-shadow-[0_0_20px_rgba(56,189,248,0.5)]"
        variants={containerVariants}
      >
        Thank You!
      </motion.h1>
      <motion.p className="mt-4 text-slate-300" variants={containerVariants}>
        Your booking has been confirmed. You&apos;ll receive a confirmation
        email shortly.
      </motion.p>
      <motion.div className="mt-8" variants={containerVariants}>
        <Link
          to="/"
          className="glow-button inline-flex items-center justify-center gap-2 py-3 px-6 rounded-lg font-semibold transition-all"
        >
          Back to Home
          <span className="glow-line glow-line-top" />
          <span className="glow-line glow-line-right" />
          <span className="glow-line glow-line-bottom" />
          <span className="glow-line glow-line-left" />
        </Link>
      </motion.div>
    </motion.section>
  );
}
