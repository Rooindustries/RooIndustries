(() => {
  const rememberReferral = () => {
    const codeFromLink = new URLSearchParams(window.location.search).get("ref")?.trim();
    let code = codeFromLink || "";
    try {
      if (code) window.sessionStorage.setItem("referral_session", code);
      else code = window.sessionStorage.getItem("referral_session") || "";
    } catch {}
    if (!code) return;
    for (const link of document.querySelectorAll("a[data-referral-link]")) {
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) continue;
      target.searchParams.set("ref", code);
      link.href = `${target.pathname}${target.search}${target.hash}`;
    }
  };
  rememberReferral();
  window.addEventListener("pageshow", rememberReferral);
})();
