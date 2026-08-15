import { notFound } from "next/navigation";
import { readTourneyBroadcastMedia } from "../../../../src/server/tourney/broadcastMedia";
import { verifyTourneyBroadcastOverlayToken } from "../../../../src/server/tourney/broadcastOverlayToken";
import {
  buildPublicLiveResponse,
  readPublicBracketApiSnapshot,
} from "../../../../src/server/tourney/publicBracketApi";
import { OverlayStyles } from "../OverlayStyles";
import CasterOverlayClient from "./CasterOverlayClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Caster Broadcast Source | Roo Industries",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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

export default async function CasterOverlayPage({ searchParams }) {
  const params = await searchParams;
  const verification = (() => {
    try {
      return verifyTourneyBroadcastOverlayToken({ token: params?.token });
    } catch {
      return { ok: false };
    }
  })();
  if (!verification.ok) notFound();

  const matchId = verification.matchId;
  const pollSeconds = clampNumber(params?.poll, 3, 60, 5);
  const scale = clampNumber(params?.scale, 0.6, 2, 1);
  const theme = String(params?.theme || "").toLowerCase() === "dark" ? "dark" : "default";
  const demo = String(params?.demo || "") === "1";
  const demoBackground = String(params?.bg || "").toLowerCase() === "gradient";
  const [snapshot, mediaCatalog] = await Promise.all([
    demo ? null : readPublicBracketApiSnapshot().catch(() => null),
    readTourneyBroadcastMedia(),
  ]);
  const initialFeed = snapshot
    ? buildPublicLiveResponse(snapshot, { matchId: matchId })
    : EMPTY_FEED;

  return (
    <>
      <OverlayStyles />
      <CasterOverlayClient
        initialFeed={initialFeed}
        matchId={String(matchId)}
        pollSeconds={pollSeconds}
        scale={scale}
        theme={theme}
        mediaCatalog={mediaCatalog}
        demo={demo}
        demoBackground={demoBackground}
      />
    </>
  );
}
