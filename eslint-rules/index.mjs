import ariaExpandedNeedsControls from "./aria-expanded-needs-controls.mjs";
import ariaLabelKeepsVisibleText from "./aria-label-keeps-visible-text.mjs";
import inputNeedsLabel from "./input-needs-label.mjs";
import noBareRoutePrefix from "./no-bare-route-prefix.mjs";
import noHandBuiltDollars from "./no-hand-built-dollars.mjs";
import noLowContrastText from "./no-low-contrast-text.mjs";
import noUnguardedTimerNavigation from "./no-unguarded-timer-navigation.mjs";

export const rules = {
  "aria-expanded-needs-controls": ariaExpandedNeedsControls,
  "aria-label-keeps-visible-text": ariaLabelKeepsVisibleText,
  "input-needs-label": inputNeedsLabel,
  "no-bare-route-prefix": noBareRoutePrefix,
  "no-hand-built-dollars": noHandBuiltDollars,
  "no-low-contrast-text": noLowContrastText,
  "no-unguarded-timer-navigation": noUnguardedTimerNavigation,
};

export default { meta: { name: "roo" }, rules };
