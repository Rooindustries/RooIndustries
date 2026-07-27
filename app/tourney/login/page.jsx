import { redirect } from "next/navigation";
import { LockScreen, getTourneySession } from "../TourneyShared";
import SupabaseSocialLogin from "../../../src/components/SupabaseSocialLogin";
import {
  PENDING_LINK_PROVIDERS,
  pendingLinkProviderLabel,
} from "../../../src/server/supabase/socialLinkProviders";

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
  const requestedProvider = String(resolvedSearchParams?.provider || "")
    .trim()
    .toLowerCase();
  const pendingLinkProvider =
    String(resolvedSearchParams?.error || "") === "unlinked" &&
    PENDING_LINK_PROVIDERS.includes(requestedProvider)
      ? requestedProvider
      : "";
  const pendingSocialLink = Boolean(pendingLinkProvider);
  const providerLabel = pendingLinkProviderLabel(pendingLinkProvider);
  const redirectTo = normalizeNextPath(resolvedSearchParams?.next);

  if (session) {
    redirect("/tourney");
  }

  return (
    <LockScreen
      error={pendingSocialLink ? "" : resolvedSearchParams?.error || ""}
      heading={pendingSocialLink ? "No account linked yet" : "Sign in."}
      subtitle={
        pendingSocialLink
          ? `This ${providerLabel} account isn't linked to a tournament account yet. Enter your Tourney username and password once and we'll link it.`
          : "Caster, player, and owner access."
      }
      note={pendingSocialLink ? "" : "Wait for approval before trying to log in."}
      buttonLabel={
        pendingSocialLink ? `Log in and link ${providerLabel}` : "Sign in"
      }
      linkDiscord={pendingSocialLink}
      linkProvider={pendingLinkProvider}
      redirectTo={redirectTo}
      showRegistrationLink={pendingSocialLink}
      socialLogin={pendingSocialLink ? null : (
        <SupabaseSocialLogin
          flow="tourney"
          nextPath={redirectTo}
          variant="tourney"
        />
      )}
      wrapSubtitle={pendingSocialLink}
    />
  );
}
