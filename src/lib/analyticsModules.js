import { reportRequestError } from "./clientRequest";
import { cleanOutsideValue } from "./outsideValue.cjs";

const lazyModule = (importModule) => {
  let loaded = null;
  let loading = null;
  const load = () => {
    loading ||= importModule().then(
      (module) => (loaded = module),
      (error) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
  const use = (action) => {
    if (loaded) action(loaded);
    else load().then(action).catch(reportRequestError);
  };
  return { load, use };
};

const salesAttribution = lazyModule(() => import("./salesAttribution"));
const metaPixel = lazyModule(() => import("./metaPixel"));
const postHogOutbox = lazyModule(() => import("./postHogOutbox"));

export const metaPixelId = () => cleanOutsideValue(process.env.NEXT_PUBLIC_META_PIXEL_ID);

export const withSalesAttribution = salesAttribution.use;

export const withPostHogOutbox = postHogOutbox.use;

export const loadSalesAttribution = () => salesAttribution.load().catch((error) => {
  reportRequestError(error);
  return null;
});

export const bookingSalesAttribution = async (stored) => {
  const module = await loadSalesAttribution();
  return module ? module.sanitizeSalesAttribution(stored) || module.captureSalesAttribution() : null;
};

export const withMetaPixel = (action) => {
  if (!metaPixelId()) return Promise.resolve(false);
  return metaPixel.load().then(action, (error) => {
    reportRequestError(error);
    return false;
  });
};

export const preloadMetaPixel = () => {
  if (metaPixelId()) metaPixel.load().catch(reportRequestError);
};
