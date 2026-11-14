import { referralSession, CHECKOUT_SAVE_NOTICE, hasCheckoutSaveFailure, subscribeCheckoutSaveFailure }
  from "../checkout-state.js";

(() => {
  const rememberReferral = () => {
    const codeFromLink = new URLSearchParams(window.location.search).get("ref")?.trim();
    let code = codeFromLink || "";
    try {
      if (code) referralSession.write(code);
      else code = referralSession.read() || "";
    } catch {}
    for (const link of document.querySelectorAll("a[data-referral-link]")) {
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) continue;
      if (code) target.searchParams.set("ref", code);
      else target.searchParams.delete("ref");
      link.href = `${target.pathname}${target.search}${target.hash}`;
    }
  };
  subscribeCheckoutSaveFailure(() => {
    if (!hasCheckoutSaveFailure() || document.querySelector("[data-checkout-save-notice]")) return;
    const notice = document.createElement("p");
    notice.dataset.checkoutSaveNotice = "";
    notice.setAttribute("role", "alert");
    notice.textContent = CHECKOUT_SAVE_NOTICE;
    document.querySelector("a[data-referral-link]")?.after(notice);
  });
  rememberReferral();
  window.addEventListener("pageshow", rememberReferral);
})();
