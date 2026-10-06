import { resolveCmsWritePauseFlag } from "../../lib/globalCmsContract.js";
import { cmsError } from "./errors.js";

export const resolveGlobalCmsWriteControl = (env = process.env) => {
  const control = resolveCmsWritePauseFlag(env.CMS_WRITES_PAUSED);
  return { writesPaused: control.paused, apiConfigured: control.configured, ready: control.configured && !control.paused, blockers: !control.configured ? ["cms_write_pause_api_invalid"] : control.paused ? ["cms_writes_paused"] : [] };
};
export const assertGlobalCmsWritesAllowed = (env = process.env) => {
  const control = resolveGlobalCmsWriteControl(env);
  if (!control.apiConfigured) throw cmsError("Content write control is unavailable.", 503, "CMS_WRITE_CONTROL_INVALID");
  if (control.writesPaused) throw cmsError("Content publishing is paused.", 423, "CMS_WRITES_PAUSED");
  return control;
};
