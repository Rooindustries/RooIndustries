"use client";

import { useEffect } from "react";
import { loadPostHog } from "../lib/loadPostHog";

export default function PostHogStart() {
  useEffect(loadPostHog, []);
  return null;
}
