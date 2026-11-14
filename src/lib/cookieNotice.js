const COOKIE_NOTICE = {
  heading: "Cookies and browser storage",
  paragraphs: [
    [
      "Roo Industries keeps a little data in your browser so the site works. Some measurement works without",
      "cookies. The roo_attr and roo_attr_last cookies, PostHog and the Meta pixel only start after you click",
      "Accept on the cookie banner.",
    ].join(" "),
    [
      "Always on: in local storage, roo-consent remembers whether you accepted or declined, roo-theme",
      "remembers light or dark mode, and roo-checkouts-counted marks each checkout you start as counted for 30 days.",
    ].join(" "),
    [
      "Always on: session storage keeps your booking draft, the time slot you are holding, your checkout",
      "progress, the referral or coupon code you used and, until you accept cookies, the link or campaign that",
      "brought you here. It also marks a visit or booking as already counted. All of it clears when you close",
      "the tab.",
    ].join(" "),
    [
      "Sign-ins: creators who log in to the referral portal get a ref_session cookie for 12 hours, or 30",
      "days with Remember me. Signing in with Discord or Google sets sign-in cookies, plus a 15 minute",
      "cookie while an account link finishes. Downloads set a 10 minute download_access cookie. Staff who",
      "edit the site get their own session cookie.",
    ].join(" "),
    [
      "Measurement without cookies: Vercel Analytics counts visits and bookings without cookies, together with",
      "the campaign, ad or referral link that brought you here. Unless you click Accept, that link is kept for",
      "the current tab only. Speed Insights measures page speed without cookies. On public pages, Seorce keeps",
      "a visit id and page count in session storage to measure search traffic.",
    ].join(" "),
    [
      "Chat: the Intercom chat widget sets its own cookies (intercom-id, intercom-session and",
      "intercom-device-id) so your conversation follows you between pages. It loads whether or not you",
      "accept, because it is how you reach support.",
    ].join(" "),
    [
      "Only after Accept: the roo_attr and roo_attr_last cookies keep the first and the latest ad, campaign",
      "or referral link that brought you here for 90 days. PostHog counts page views and booking steps",
      "without cookies, and records how public pages are used with every input and all page text hidden.",
      "When our Meta pixel is turned on, it tells Meta which pages and packages you viewed and when you",
      "start checkout or book, so we can measure our ads. It never sends your name, email or phone, and",
      "Meta sets its own _fbp and _fbc cookies.",
    ].join(" "),
    [
      "Contact messages: messages sent through the contact form are stored so we can reply. Delivered",
      "messages are deleted after 30 days.",
    ].join(" "),
    [
      "Changing your choice: use Cookie settings at the bottom of any page. Declining removes the roo_attr,",
      "roo_attr_last, _fbp and _fbc cookies and stops PostHog and the Meta pixel.",
    ].join(" "),
  ],
};

const COOKIE_NOTICE_KEY = "roo-cookie-notice";

const cookieNoticeSection = () => ({
  _key: COOKIE_NOTICE_KEY,
  heading: COOKIE_NOTICE.heading,
  content: COOKIE_NOTICE.paragraphs.map((text, index) => ({
    _type: "block",
    _key: `${COOKIE_NOTICE_KEY}-${index}`,
    style: "normal",
    markDefs: [],
    children: [{ _type: "span", _key: `${COOKIE_NOTICE_KEY}-${index}-text`, text, marks: [] }],
  })),
});

const withCookieNotice = (privacy) => {
  if (!privacy || typeof privacy !== "object") return privacy;
  const sections = (Array.isArray(privacy.sections) ? privacy.sections : [])
    .filter((section) => section?._key !== COOKIE_NOTICE_KEY);
  return { ...privacy, sections: [...sections, cookieNoticeSection()] };
};

module.exports = { COOKIE_NOTICE, withCookieNotice };
module.exports.default = module.exports;
