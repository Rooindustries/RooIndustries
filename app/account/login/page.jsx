import SocialLogin from "./social-login";
import styles from "../account.module.css";

export const metadata = {
  title: "Sign In | Roo Industries",
  description: "Sign in to your Roo Industries account.",
  robots: { index: false, follow: false, nocache: true },
};

const safeNextPath = (value) => {
  const path = String(value || "/account").trim();
  if (
    !/^\/(?!\/)[^\\\u0000-\u001f]*$/.test(path) ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/callback") ||
    path === "/account/login"
  ) {
    return "/account";
  }
  return path;
};

const errorMessages = {
  account_setup_failed:
    "Your sign-in worked, but the account could not be linked safely. Please try again.",
};

export default async function AccountLoginPage({ searchParams }) {
  const params = await searchParams;
  const error = errorMessages[String(params?.error || "")] || "";

  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="account-sign-in-heading">
        <p className={styles.eyebrow}>Roo Industries account</p>
        <h1 id="account-sign-in-heading">Sign in</h1>
        <p className={styles.intro}>
          Use the account you want linked to your bookings and optimization app.
        </p>
        <SocialLogin nextPath={safeNextPath(params?.next)} />
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <p className={styles.note}>
          Tourney and creator logins continue to use their existing sign-in pages.
        </p>
      </section>
    </main>
  );
}
