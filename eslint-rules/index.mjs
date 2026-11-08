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
import noLinuxOnlyTestTooling from "./no-linux-only-test-tooling.mjs";
import noLowContrastText from "./no-low-contrast-text.mjs";
import noNestedComponents from "./no-nested-components.mjs";
import noParentIpcDisconnect from "./no-parent-ipc-disconnect.mjs";
import noScriptingMediaQuery from "./no-scripting-media-query.mjs";
import noScatteredSelfReferral from "./no-scattered-self-referral.mjs";
import noSecureContextNavigationKeys from "./no-secure-context-navigation-keys.mjs";
import noUncheckedGroupSignal from "./no-unchecked-group-signal.mjs";
import noUnfilteredRequestError from "./no-unfiltered-request-error.mjs";
import noUnguardedTimerNavigation from "./no-unguarded-timer-navigation.mjs";
import noVirtualMockOfInstalledModule from "./no-virtual-mock-of-installed-module.mjs";
import smoothScrollNeedsMotionCheck from "./smooth-scroll-needs-motion-check.mjs";

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
  "no-linux-only-test-tooling": noLinuxOnlyTestTooling,
  "no-low-contrast-text": noLowContrastText,
  "no-nested-components": noNestedComponents,
  "no-parent-ipc-disconnect": noParentIpcDisconnect,
  "no-scripting-media-query": noScriptingMediaQuery,
  "no-scattered-self-referral": noScatteredSelfReferral,
  "no-secure-context-navigation-keys": noSecureContextNavigationKeys,
  "no-unchecked-group-signal": noUncheckedGroupSignal,
  "no-unfiltered-request-error": noUnfilteredRequestError,
  "no-unguarded-timer-navigation": noUnguardedTimerNavigation,
  "no-virtual-mock-of-installed-module": noVirtualMockOfInstalledModule,
  "smooth-scroll-needs-motion-check": smoothScrollNeedsMotionCheck,
};

export default { meta: { name: "roo" }, rules };
