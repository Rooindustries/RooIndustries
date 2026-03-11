import cronSyncAll from "../../../../src/server/api/ref/cronSyncAll.js";
import createBooking from "../../../../src/server/api/ref/createBooking.js";
import forgot from "../../../../src/server/api/ref/forgot.js";
import getData from "../../../../src/server/api/ref/getData.js";
import getUpgradeInfo from "../../../../src/server/api/ref/getUpgradeInfo.js";
import hashPassword from "../../../../src/server/api/ref/hashPassword.js";
import login from "../../../../src/server/api/ref/login.js";
import logout from "../../../../src/server/api/ref/logout.js";
import payouts from "../../../../src/server/api/ref/payouts.js";
import register from "../../../../src/server/api/ref/register.js";
import reset from "../../../../src/server/api/ref/reset.js";
import sendBookingEmails from "../../../../src/server/api/ref/sendBookingEmails.js";
import syncPayouts from "../../../../src/server/api/ref/syncPayouts.js";
import updateBookingStatus from "../../../../src/server/api/ref/updateBookingStatus.js";
import updatePayments from "../../../../src/server/api/ref/updatePayments.js";
import updateSplit from "../../../../src/server/api/ref/updateSplit.js";
import validateCoupon from "../../../../src/server/api/ref/validateCoupon.js";
import validateReferral from "../../../../src/server/api/ref/validateReferral.js";
import webhookSync from "../../../../src/server/api/ref/webhookSync.js";
import { runLegacyApiHandler } from "../../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_HANDLERS = {
  cronSyncAll,
  createBooking,
  forgot,
  getData,
  getUpgradeInfo,
  hashPassword,
  login,
  logout,
  payouts,
  register,
  reset,
  sendBookingEmails,
  syncPayouts,
  updateBookingStatus,
  updatePayments,
  updateSplit,
  validateCoupon,
  validateReferral,
  webhookSync,
};

async function handle(request, context, methodOverride) {
  const { action } = await context.params;
  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  return runLegacyApiHandler({ request, handler, methodOverride });
}

export const GET = (request, context) => handle(request, context, "GET");
export const POST = (request, context) => handle(request, context, "POST");
