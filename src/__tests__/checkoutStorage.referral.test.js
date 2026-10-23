import {
  captureReferralAddress,
  clearStoredReferral,
  getReferralCaptureFailure,
  recordAutomaticReferral,
  referralScope,
  selectStoredReferral,
} from "../lib/checkoutStorage";

const scope = referralScope("Performance Vertex Overhaul");

const journal = (intent) => JSON.parse(window.sessionStorage.getItem("referral_dismissed"));

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/payment");
  captureReferralAddress("/payment", "");
});

test("clearing an invalid applied code keeps a newer passive code selectable", () => {
  window.sessionStorage.setItem("referral_capture", "ready");
  window.sessionStorage.setItem("referral_dismissed", JSON.stringify({
    passiveCode: "creatorb",
    codes: { creatora: "applied", creatorb: "available" },
    choices: { [scope]: "creatora" },
  }));
  window.sessionStorage.setItem("referral_session", "creatorb");

  expect(clearStoredReferral("CreatorA")).toBe(true);

  expect(journal()).toMatchObject({
    passiveCode: "creatorb",
    codes: { creatora: "removed", creatorb: "available" },
    choices: {},
  });
  expect(window.sessionStorage.getItem("referral_session")).toBe("creatorb");
  expect(window.sessionStorage.getItem("referral_capture")).toBe("ready");
  expect(selectStoredReferral(scope)).toBe("creatorb");
});

test("a new payment candidate stays selectable when recording it fails", () => {
  window.history.replaceState(null, "", "/payment?ref=friend");
  window.sessionStorage.setItem("referral_capture", "ready");
  const setItem = Storage.prototype.setItem;
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
    if (key === "referral_dismissed") throw new DOMException("denied", "QuotaExceededError");
    return setItem.call(this, key, value);
  });
  try {
    expect(selectStoredReferral(scope, ["friend"])).toBe("friend");
    expect(getReferralCaptureFailure()).toBeNull();
    expect(window.sessionStorage.getItem("referral_dismissed")).toBeNull();
    expect(recordAutomaticReferral("friend", scope)).toBe(false);
  } finally {
    jest.restoreAllMocks();
  }
});

test("a referral journal write marks the capture ready when no capture is in progress", () => {
  expect(getReferralCaptureFailure()).toBeNull();
  expect(recordAutomaticReferral("creatorb", scope)).toBe(true);
  expect(window.sessionStorage.getItem("referral_capture")).toBe("ready");
  expect(journal().choices).toEqual({ [scope]: "creatorb" });
});

test("a missing capture marker stays a failure and a passive visit does not acknowledge it", () => {
  window.history.replaceState(null, "", "/payment");
  window.sessionStorage.clear();
  window.sessionStorage.setItem("referral_dismissed", JSON.stringify({
    passiveCode: "creatorb",
    codes: { creatora: "applied", creatorb: "available" },
    choices: { [scope]: "creatora" },
  }));
  window.sessionStorage.setItem("referral_session", "creatorb");

  jest.isolateModules(() => {
    const isolated = require("../lib/checkoutStorage");
    expect(isolated.getReferralCaptureFailure()).toEqual({ code: "", address: "" });
    expect(window.sessionStorage.getItem("referral_capture")).not.toBe("ready");

    window.history.replaceState(null, "", "/about?ref=creatorb");
    isolated.captureReferralAddress("/about", "?ref=creatorb");

    expect(window.sessionStorage.getItem("referral_capture")).not.toBe("ready");
    expect(isolated.getReferralCaptureFailure()).toEqual({ code: "", address: "" });
    expect(isolated.selectStoredReferral(scope)).toBe("");
    expect(JSON.parse(window.sessionStorage.getItem("referral_dismissed")).choices).toEqual({ [scope]: "creatora" });
  });
});
