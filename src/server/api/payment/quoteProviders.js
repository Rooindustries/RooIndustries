const { resolvePaymentProviders } = require("./providerConfig.js");

module.exports = ({ isFree }) => {
  const providers = resolvePaymentProviders();
  return isFree
    ? {
        razorpay: { enabled: false, mode: providers.razorpay.mode },
        paypal: { enabled: false, mode: providers.paypal.mode, clientId: "" },
      }
    : providers;
};
