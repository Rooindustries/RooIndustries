import ariaExpandedNeedsControls from "./aria-expanded-needs-controls.mjs";
import ariaLabelKeepsVisibleText from "./aria-label-keeps-visible-text.mjs";
import fetchNeedsDeadline from "./fetch-needs-deadline.mjs";
import inputNeedsLabel from "./input-needs-label.mjs";
import noBareRoutePrefix from "./no-bare-route-prefix.mjs";
import noHandBuiltDollars from "./no-hand-built-dollars.mjs";
import noIgnoredWriteRequest from "./no-ignored-write-request.mjs";
import noLowContrastText from "./no-low-contrast-text.mjs";
import noUnguardedTimerNavigation from "./no-unguarded-timer-navigation.mjs";

export const rules = {
  "aria-expanded-needs-controls": ariaExpandedNeedsControls,
  "aria-label-keeps-visible-text": ariaLabelKeepsVisibleText,
  "fetch-needs-deadline": fetchNeedsDeadline,
  "input-needs-label": inputNeedsLabel,
  "no-bare-route-prefix": noBareRoutePrefix,
  "no-hand-built-dollars": noHandBuiltDollars,
  "no-ignored-write-request": noIgnoredWriteRequest,
  "no-low-contrast-text": noLowContrastText,
  "no-unguarded-timer-navigation": noUnguardedTimerNavigation,
};

export default { meta: { name: "roo" }, rules };
