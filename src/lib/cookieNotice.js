const COOKIE_NOTICE = {
  heading: "Cookies and browser storage",
  paragraphs: [
    [
      "Roo Industries keeps a little data in your browser so the site works. Ad measurement only starts",
      "after you click Accept on the cookie banner.",
    ].join(" "),
    [
      "Always on: roo-consent in local storage remembers whether you accepted or declined, and roo-theme",
      "remembers light or dark mode.",
    ].join(" "),
    [
      "Always on: session storage keeps your booking draft, the time slot you are holding, your checkout",
      "progress, the referral or coupon code you used and the link or campaign that brought you here. It",
      "also marks a visit or booking as already counted. All of it clears when you close the tab.",
    ].join(" "),
    [
      "Sign-ins: creators who log in to the referral portal get a ref_session cookie for 12 hours, or 30",
      "days with Remember me. Signing in with Discord or Google sets sign-in cookies, plus a 15 minute",
      "cookie while an account link finishes. Downloads set a 10 minute download_access cookie. Staff who",
      "edit the site get their own session cookie.",
    ].join(" "),
    [
      "Measurement without cookies: Vercel Analytics and Speed Insights count page visits and page speed",
      "without cookies. On public pages, Seorce keeps a visit id and page count in session storage to",
      "measure search traffic.",
    ].join(" "),
    [
      "Chat: the Intercom chat widget sets its own cookies (intercom-id, intercom-session and",
      "intercom-device-id) so your conversation follows you between pages. It loads whether or not you",
      "accept, because it is how you reach support.",
    ].join(" "),
    [
      "Only after Accept: the roo_attr cookie keeps the ad, campaign or referral link that brought you here",
      "for 90 days. When our Meta pixel is turned on, it tells Meta which pages you viewed and when you",
      "start checkout or book, so we can measure our ads. It never sends your name, email or phone, and",
      "Meta sets its own _fbp cookie.",
    ].join(" "),
    [
      "Contact messages: messages sent through the contact form are stored so we can reply. Delivered",
      "messages are deleted after 30 days.",
    ].join(" "),
    [
      "Changing your choice: use Cookie settings at the bottom of any page. Declining removes the roo_attr",
      "cookie and stops the Meta pixel.",
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
