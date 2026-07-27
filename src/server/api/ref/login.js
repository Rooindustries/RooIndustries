import { createDataClient as createClient } from "../../data/documentClient.js";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import {
  isActiveReferralFallbackAuthority,
  readReferralFallbackAuthority,
  setReferralSessionCookie,
} from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import {
  resolveSupabaseRuntimePolicy,
  shouldUseSupabaseForAccount,
} from "../../supabase/runtime.js";
import { authenticateSupabaseAccount } from "../../supabase/accounts.js";
import {
  clearLegacySupabaseSession,
  getLegacySupabaseUser,
  installLegacySupabaseSession,
} from "../../supabase/serverSession.js";
import {
  appendPendingDiscordLinkCookie,
  clearPendingDiscordLinkCookie,
  linkPendingDiscordIdentity,
  PENDING_LINK_PROVIDERS,
  resolvePendingDiscordUser,
  resolvePendingSocialLink,
} from "../../supabase/pendingSocialLink.js";

const linkFailedMessage = (provider) => {
  const label = provider === "google" ? "Google" : "Discord";
  return `${label} linking did not complete. Try the ${label} login again.`;
};

const normalizeLinkProvider = (value) => {
  const provider = String(value || "").trim().toLowerCase();
  return PENDING_LINK_PROVIDERS.includes(provider) ? provider : "discord";
};

// The legacy OAuth session fallback has no proof naming a provider, so the
// provider is read off the user's own identities. The requested one is preferred
// when present; otherwise the single linkable identity on the user is used.
const legacyIdentityProvider = (user, requested) => {
  const held = new Set(
    (user?.identities || [])
      .map((identity) => String(identity?.provider || "").trim().toLowerCase())
      .filter((provider) => PENDING_LINK_PROVIDERS.includes(provider))
  );
  if (held.has(requested)) return requested;
  return held.size === 1 ? [...held][0] : requested;
};

const DUMMY_PASSWORD_HASH =
  // nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
  "$2b$12$6584hc9FBR7p989gOkedS.vPcNBNo89i4Inr1NKZPvdlqMwuNzKfi";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
}, { allowLegacyFallback: false });

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const {
      code,
      linkDiscord = false,
      linkProvider = "",
      password,
      rememberMe = false,
    } = req.body || {};
    const requestedLinkProvider = normalizeLinkProvider(linkProvider);
    const normalizedIdentifier = String(code || "").trim().toLowerCase();
    const normalizedPassword = String(password || "");
    if (!normalizedIdentifier || normalizedIdentifier.length > 254 || normalizedPassword.length > 128) {
      return res.status(400).json({ ok: false, error: "Invalid login request." });
    }
    const clientAddress = getClientAddress(req);

    if (
      !(await requireRateLimit(res, {
        key: `ref-login:${clientAddress}`,
        max: 10,
        windowMs: 15 * 60 * 1000,
      }))
    ) {
      return;
    }

    const policy = resolveSupabaseRuntimePolicy();
    const manualFallback =
      policy.primaryBackend === "sanity" && policy.cutoverEnabled;
    if (
      !manualFallback &&
      shouldUseSupabaseForAccount({ identifier: normalizedIdentifier })
    ) {
      const result = await authenticateSupabaseAccount({
        identifier: normalizedIdentifier,
        password: normalizedPassword,
        requiredRoles: ["creator"],
        verifyLegacyPassword: async ({ account }) => {
          const legacy = await client.fetch(
            `*[_type == "referral" && _id == $id][0]{_id,_rev,creatorPassword}`,
            { id: account.legacy_sanity_id }
          );
          const stored = String(legacy?.creatorPassword || "");
          if (!stored || /^\$2[aby]\$/.test(stored)) return false;
          const suppliedBuffer = Buffer.from(normalizedPassword);
          const storedBuffer = Buffer.from(stored);
          const valid =
            suppliedBuffer.length === storedBuffer.length &&
            crypto.timingSafeEqual(suppliedBuffer, storedBuffer);
          if (!valid) return false;
          const hash = await bcrypt.hash(normalizedPassword, 12);
          let patch = client.patch(legacy._id);
          if (legacy._rev) patch = patch.ifRevisionId(legacy._rev);
          await patch
            .set({
              creatorPassword: hash,
              credentialVersion: 2,
              passwordResetRequired: false,
              passwordStorageUpgradedAt: new Date().toISOString(),
            })
            .commit({ visibility: "sync" });
          return true;
        },
      });
      if (!result.ok) {
        return res.status(result.reason === "unavailable" ? 503 : 401).json({
          ok: false,
          error:
            result.reason === "unavailable"
              ? "Login is temporarily unavailable. Please try again shortly."
              : "Invalid login details. Use Forgot Password if you need to reset access.",
        });
      }

      let discordLinked = false;
      let discordLinkError = "";
      let linkedProvider = "";
      if (linkDiscord) {
        // The proof names its own provider. When none is held the legacy OAuth
        // session is the fallback, and there the provider comes from the identity
        // actually on that user rather than from the request body.
        const pendingLink = resolvePendingSocialLink({
          provider: requestedLinkProvider,
          request: req,
        });
        let resolvedProvider = pendingLink?.provider || requestedLinkProvider;
        let pendingDiscordUser = pendingLink
          ? await resolvePendingDiscordUser({
              provider: pendingLink.provider,
              request: req,
            }).catch((error) => {
              logSafeError("Pending social link proof lookup failed", error);
              return null;
            })
          : null;
        if (!pendingDiscordUser) {
          pendingDiscordUser = await getLegacySupabaseUser({ req, res }).catch(
            () => null
          );
          resolvedProvider = legacyIdentityProvider(
            pendingDiscordUser,
            requestedLinkProvider
          );
        }
        try {
          const linked = await linkPendingDiscordIdentity({
            pendingUser: pendingDiscordUser,
            primaryAccount: result.account,
            primaryUserId: result.user.id,
            provider: resolvedProvider,
          });
          if (!linked.linked) {
            discordLinkError = linkFailedMessage(resolvedProvider);
          } else {
            discordLinked = true;
            linkedProvider = linked.provider || resolvedProvider;
          }
        } catch (error) {
          logSafeError("Referral social account linking failed", error);
          discordLinkError = linkFailedMessage(resolvedProvider);
        }
      }

      await clearLegacySupabaseSession({ req, res }).catch(() => {});
      await installLegacySupabaseSession({
        req,
        res,
        session: result.session,
      });
      if (linkDiscord) {
        for (const provider of PENDING_LINK_PROVIDERS) {
          appendPendingDiscordLinkCookie(
            res,
            clearPendingDiscordLinkCookie({ provider })
          );
        }
      }

      setReferralSessionCookie(
        res,
        {
          referralId:
            result.account.creator_legacy_sanity_id || result.account.legacy_sanity_id,
          code: result.account.referral_code || normalizedIdentifier,
          authBackend: "supabase",
          principalId: result.account.principal_id,
          sessionVersion: result.account.session_version,
        },
        Boolean(rememberMe)
      );
      return res.json({
        ok: true,
        creatorId: result.account.legacy_sanity_id,
        name: result.account.display_name,
        code: result.account.referral_code,
        ...(discordLinked ? { discordLinked: true } : {}),
        ...(linkedProvider ? { linkedProvider } : {}),
        ...(discordLinkError ? { discordLinkError } : {}),
      });
    }

    const referral = await client.fetch(
      `*[
        _type == "referral"
        && registrationStatus != "pending_email"
        && (
          (defined(slug.current) && lower(slug.current) == $identifier)
          || (defined(creatorEmail) && lower(creatorEmail) == $identifier)
        )
      ][0]{_id,_rev,name,slug,creatorPassword,passwordResetRequired}`,
      { identifier: normalizedIdentifier }
    );

    const stored = String(referral?.creatorPassword || "");
    const looksHashed = /^\$2[aby]\$/.test(stored);
    const suppliedBuffer = Buffer.from(normalizedPassword);
    const storedBuffer = Buffer.from(stored);
    const legacyValid =
      !looksHashed &&
      storedBuffer.length > 0 &&
      suppliedBuffer.length === storedBuffer.length &&
      crypto.timingSafeEqual(suppliedBuffer, storedBuffer);
    const hashedValid = await bcrypt.compare(
      normalizedPassword,
      looksHashed ? stored : DUMMY_PASSWORD_HASH
    );
    const valid = looksHashed ? hashedValid : legacyValid;
    if (!referral || !valid || referral.passwordResetRequired === true) {
      return res.status(401).json({
        ok: false,
        error: "Invalid login details. Use Forgot Password if you need to reset access.",
      });
    }

    if (!looksHashed) {
      try {
        const hash = await bcrypt.hash(normalizedPassword, 12);
        let patch = client.patch(referral._id);
        if (referral._rev) patch = patch.ifRevisionId(referral._rev);
        await patch
          .set({
            creatorPassword: hash,
            credentialVersion: 2,
            passwordResetRequired: false,
            passwordStorageUpgradedAt: new Date().toISOString(),
          })
          .commit({ visibility: "sync" });
      } catch (error) {
        logSafeError("Referral password storage upgrade failed", error);
      }
    }

    let fallbackAuthority = null;
    if (manualFallback) {
      try {
        fallbackAuthority = await readReferralFallbackAuthority({
          legacyCreatorId: referral._id,
        });
      } catch (error) {
        logSafeError("Referral fallback authority read failed", error);
        return res.status(503).json({
          ok: false,
          error: "Login is temporarily unavailable. Please try again shortly.",
        });
      }
      if (!fallbackAuthority) {
        return res.status(503).json({
          ok: false,
          error: "Login is temporarily unavailable. Please try again shortly.",
        });
      }
      if (
        !isActiveReferralFallbackAuthority(fallbackAuthority, {
          legacyCreatorId: referral._id,
          referralCode: referral.slug?.current,
        })
      ) {
        return res.status(401).json({
          ok: false,
          error:
            "Invalid login details. Use Forgot Password if you need to reset access.",
        });
      }
    }

    setReferralSessionCookie(
      res,
      {
        referralId: referral._id,
        code: referral.slug?.current || code,
        authBackend: "sanity",
        principalId: fallbackAuthority?.principalId || "",
        sessionVersion: fallbackAuthority?.principalSessionVersion || 1,
        credentialVersion: fallbackAuthority?.credentialVersion || 1,
      },
      Boolean(rememberMe)
    );

    return res.json({
      ok: true,
      creatorId: referral._id,
      name: referral.name,
      code: referral.slug.current,
    });
  } catch (err) {
    logSafeError("Referral login failed", err);
    return res.status(500).json({ ok: false });
  }
}
