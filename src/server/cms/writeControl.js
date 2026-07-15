import { resolveCmsWritePauseFlag } from "../../lib/globalCmsContract.js";

const unavailable = (message, code) => {
  const error = new Error(message);
  error.status = 503;
  error.statusCode = 503;
  error.code = code;
  return error;
};

export const resolveGlobalCmsWriteControl = (env = process.env) => {
  const api = resolveCmsWritePauseFlag(env.CMS_WRITES_PAUSED);
  const studio = resolveCmsWritePauseFlag(
    env.SANITY_STUDIO_CMS_WRITES_PAUSED,
  );
  const matches =
    api.configured && studio.configured && api.paused === studio.paused;
  const blockers = [];
  if (!api.configured) blockers.push("cms_write_pause_api_invalid");
  if (!studio.configured) blockers.push("cms_write_pause_studio_invalid");
  if (api.configured && studio.configured && !matches) {
    blockers.push("cms_write_pause_mismatch");
  }
  if (api.paused) blockers.push("cms_writes_paused");
  return {
    writesPaused: api.paused,
    studioWritesPaused: studio.paused,
    apiConfigured: api.configured,
    studioConfigured: studio.configured,
    matches,
    ready: blockers.length === 0,
    blockers,
  };
};

export const assertGlobalCmsWritesAllowed = (env = process.env) => {
  const control = resolveGlobalCmsWriteControl(env);
  if (!control.apiConfigured || !control.studioConfigured) {
    throw unavailable(
      "Content publishing is paused because its write control is unavailable.",
      "CMS_WRITE_CONTROL_INVALID",
    );
  }
  if (!control.matches) {
    throw unavailable(
      "Content publishing is paused because its write controls do not match.",
      "CMS_WRITE_CONTROL_MISMATCH",
    );
  }
  if (control.writesPaused) {
    throw unavailable(
      "Content publishing is temporarily paused.",
      "CMS_WRITES_PAUSED",
    );
  }
  return control;
};
