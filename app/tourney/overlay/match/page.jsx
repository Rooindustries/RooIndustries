import {
  buildPublicLiveResponse,
  readPublicBracketApiSnapshot,
} from "../../../../src/server/tourney/publicBracketApi";
import { OverlayStyles } from "../OverlayStyles";
import MatchStripClient from "./MatchStripClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Live Match Overlay | Roo Industries",
};

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const EMPTY_FEED = Object.freeze({
  ok: true,
  apiVersion: "1",
  version: "",
  updatedAt: "",
  generated: false,
  published: false,
  live: [],
  upNext: [],
});

export default async function MatchOverlayPage({ searchParams }) {
  const params = await searchParams;
  const pollSeconds = clampNumber(params?.poll, 3, 60, 8);
  const scale = clampNumber(params?.scale, 0.6, 2, 1);
  const demo = String(params?.demo || "") === "1";
  const demoBackground = String(params?.bg || "").toLowerCase() === "gradient";

  const snapshot = demo
    ? null
    : await readPublicBracketApiSnapshot().catch(() => null);
  const initialFeed = demo
    ? EMPTY_FEED
    : snapshot
      ? buildPublicLiveResponse(snapshot)
      : EMPTY_FEED;

  return (
    <>
      <OverlayStyles />
      <MatchStripClient
        initialFeed={initialFeed}
        pollSeconds={pollSeconds}
        scale={scale}
        demo={demo}
        demoBackground={demoBackground}
      />
    </>
  );
}
