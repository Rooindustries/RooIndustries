export const cmsError = (message, status, code, details) => Object.assign(new Error(message), { status, statusCode: status, code, ...(details === undefined ? {} : { details }) });
export const validationError = (path, message) => cmsError("Content validation failed.", 400, "CMS_VALIDATION_FAILED", [{ path, message }]);
export const rpcData = ({ data, error }, operation = "CMS operation") => {
  if (!error) return data;
  let details;
  try { details = JSON.parse(error.details); } catch { details = undefined; }
  const text = String(error.message || "");
  if (text.includes("CMS_ASSET_SOURCE_COLLISION")) throw cmsError("The stored asset source disagrees with these bytes. Owner attention is required.", 422, "CMS_ASSET_SOURCE_COLLISION");
  const validationCodes = {
    CMS_CODE_CONFLICT: ["$.code", "This code is already used by a coupon or referral creator."],
    CMS_PACKAGE_TITLE_CONFLICT: ["$.title", "This package title or alias is already in use."],
    CMS_PRICE_INVALID: ["$.price", "Price must parse to a positive amount."],
    CMS_SLUG_INVALID: ["$.slug", "Use 1 to 80 letters, numbers or hyphens for the URL slug."],
    CMS_SLUG_CONFLICT: ["$.slug", "This URL slug is already in use."],
    CMS_SINGLETON_REQUIRED: ["$.operation", "Singleton content cannot be deleted."],
    CMS_SINGLETON_IDENTITY: ["$.documentId", "This singleton must retain its fixed identity."],
    CMS_REFERENCE_INVALID: [details?.path || "$", "The reference target is missing or has the wrong type."],
    CMS_ASSET_UNVERIFIED: [details?.path || "$", "Upload and verify this asset before publishing."],
  };
  const validation = Object.keys(validationCodes).find(code => text.includes(code));
  if (validation) throw validationError(...validationCodes[validation]);
  const codes = ["CMS_CREATE_INTENT_CONFLICT", "CMS_TYPE_MISMATCH", "CMS_REVISION_CONFLICT", "CMS_REFERENCED", "CMS_SINGLETON_EXISTS"];
  const code = codes.find(code => text.includes(code));
  if (code === "CMS_TYPE_MISMATCH") throw cmsError("Document type conflicts with its stored identity.", 409, code, details);
  if (code === "CMS_CREATE_INTENT_CONFLICT") throw cmsError("This create attempt already published a document. Load it and edit the latest version.", 409, code, details);
  if (code) throw cmsError(code === "CMS_REVISION_CONFLICT" ? "This document changed. Reload and try again." : code === "CMS_REFERENCED" ? "This document is referenced by live content." : "This singleton already exists.", 409, code, details);
  if (text.startsWith("CMS_") && error.code === "23505") throw cmsError("This content conflicts with stored content.", 409, text.match(/^CMS_[A-Z0-9_]+/)[0], details);
  if (["40001", "23505"].includes(error.code)) throw cmsError("This content conflicts with stored content.", 409, "CMS_REVISION_CONFLICT", details || { currentRevision: null });
  if (["22023", "23503", "23514"].includes(error.code)) throw validationError(details?.path || "$", text.startsWith("CMS_") ? text : "The request violates content integrity.");
  if (error.code === "P0002") throw cmsError("Document not found.", 404, "CMS_NOT_FOUND");
  throw cmsError(`${operation} is temporarily unavailable.`, 503, "CMS_UNAVAILABLE");
};
