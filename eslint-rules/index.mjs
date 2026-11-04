import ariaExpandedNeedsControls from "./aria-expanded-needs-controls.mjs";
import ariaLabelKeepsVisibleText from "./aria-label-keeps-visible-text.mjs";
import fetchNeedsDeadline from "./fetch-needs-deadline.mjs";
import inputNeedsLabel from "./input-needs-label.mjs";
import inputsNeedForm from "./inputs-need-form.mjs";
import noAriaLabelOnGeneric from "./no-aria-label-on-generic.mjs";
import noBareRoutePrefix from "./no-bare-route-prefix.mjs";
import noClientOnlyPublicContent from "./no-client-only-public-content.mjs";
import noHandBuiltDollars from "./no-hand-built-dollars.mjs";
import noHandBuiltNodeOptions from "./no-hand-built-node-options.mjs";
import noHiddenServerMotion from "./no-hidden-server-motion.mjs";
import noIgnoredWriteRequest from "./no-ignored-write-request.mjs";
import noLowContrastText from "./no-low-contrast-text.mjs";
import noNestedComponents from "./no-nested-components.mjs";
import noScriptingMediaQuery from "./no-scripting-media-query.mjs";
import noUnguardedTimerNavigation from "./no-unguarded-timer-navigation.mjs";

export const rules = {
  "aria-expanded-needs-controls": ariaExpandedNeedsControls,
  "aria-label-keeps-visible-text": ariaLabelKeepsVisibleText,
  "fetch-needs-deadline": fetchNeedsDeadline,
  "input-needs-label": inputNeedsLabel,
  "inputs-need-form": inputsNeedForm,
  "no-aria-label-on-generic": noAriaLabelOnGeneric,
  "no-bare-route-prefix": noBareRoutePrefix,
  "no-client-only-public-content": noClientOnlyPublicContent,
  "no-hand-built-dollars": noHandBuiltDollars,
  "no-hand-built-node-options": noHandBuiltNodeOptions,
  "no-hidden-server-motion": noHiddenServerMotion,
  "no-ignored-write-request": noIgnoredWriteRequest,
  "no-low-contrast-text": noLowContrastText,
  "no-nested-components": noNestedComponents,
  "no-scripting-media-query": noScriptingMediaQuery,
  "no-unguarded-timer-navigation": noUnguardedTimerNavigation,
};

export default { meta: { name: "roo" }, rules };
