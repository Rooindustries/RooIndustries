import homeCopy from "./homeCopy";
import packageContent from "./packageContent";

const { applyHomeSectionCopyOverride } = homeCopy;
const { buildPackageOffers, normalizeFaqQuestions } = packageContent;

export const normalizeContent = (resource, value) => {
  const copyValue = applyHomeSectionCopyOverride(resource, value);
  if (resource === "packages-list") return buildPackageOffers(copyValue);
  if (resource === "faq-questions") return normalizeFaqQuestions(copyValue);
  return copyValue;
};
