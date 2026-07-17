import { redirect } from "next/navigation";
import { LockScreen, getTourneySession } from "../TourneyShared";
import SupabaseSocialLogin from "../../../src/components/SupabaseSocialLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign In | Roo Industries",
  description: "Sign in to a Roo Industries event account.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

const normalizeNextPath = (value) => {
  const path = String(value || "/tourney").trim();
  if (
    !path.startsWith("/tourney") ||
    path.startsWith("//") ||
    path.startsWith("/api/") ||
    path === "/tourney/login"
  ) {
    return "/tourney";
  }
  return path;
};

export default async function TourneyLoginPage({ searchParams }) {
  const resolvedSearchParams = await searchParams;
  const session = await getTourneySession();
  const pendingDiscordLink =
    String(resolvedSearchParams?.error || "") === "unlinked" &&
    String(resolvedSearchParams?.provider || "") === "discord";
  const redirectTo = normalizeNextPath(resolvedSearchParams?.next);

  if (session) {
    redirect("/tourney");
  }

  return (
    <LockScreen
      error={pendingDiscordLink ? "" : resolvedSearchParams?.error || ""}
      heading={pendingDiscordLink ? "No account linked yet" : "Sign in."}
      subtitle={
        pendingDiscordLink
          ? "This Discord isn't linked to a tournament account yet. Enter your Tourney username and password once and we'll link it."
          : "Caster, player, and owner access."
      }
      note={pendingDiscordLink ? "" : "Wait for approval before trying to log in."}
      buttonLabel={pendingDiscordLink ? "Log in and link Discord" : "Sign in"}
      linkDiscord={pendingDiscordLink}
      redirectTo={redirectTo}
      showRegistrationLink={pendingDiscordLink}
      socialLogin={pendingDiscordLink ? null : (
        <SupabaseSocialLogin
          flow="tourney"
          nextPath={redirectTo}
          variant="tourney"
        />
      )}
      wrapSubtitle={pendingDiscordLink}
    />
  );
}
