const loaders = {
  paid: () => import("../legacyPages/PaymentSuccess"),
  free: () => import("../legacyPages/Thankyou"),
};
const requests = {};
const pages = {};

export function preloadConfirmationPage(kind) {
  if (!requests[kind]) {
    requests[kind] = loaders[kind]().then(module => {
      pages[kind] = module.default;
      return module;
    }).catch(error => {
      delete requests[kind];
      throw error;
    });
  }
  return requests[kind];
}

export const getConfirmationPage = kind => pages[kind];

export const preloadConfirmationPages = () => Promise.all([
  preloadConfirmationPage("paid"),
  preloadConfirmationPage("free"),
]);
