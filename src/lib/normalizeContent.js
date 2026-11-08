import homeCopy from "./homeCopy";
import packageContent from "./packageContent";
import toolContent from "./toolContent";

const { applyHomeSectionCopyOverride } = homeCopy;
const { buildPackageOffers, normalizeFaqQuestions } = packageContent;
const { normalizeTools } = toolContent;

export const normalizeContent = (resource, value) => {
  const copyValue = applyHomeSectionCopyOverride(resource, value);
  if (resource === "packages-list") return buildPackageOffers(copyValue);
  if (resource === "faq-questions") return normalizeFaqQuestions(copyValue);
  if (resource === "tools") return normalizeTools(copyValue);
  return copyValue;
};
