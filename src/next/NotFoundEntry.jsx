"use client";

import dynamic from "next/dynamic";

const LegacyRoutePage = dynamic(() => import("./LegacyRoutePage"));

export default function NotFoundEntry(props) {
  return <LegacyRoutePage {...props} />;
}
