set -eu
node scripts/test-sanity-runtime-imports.mjs
node scripts/test-sanity-runtime-waits.mjs
node scripts/test-sanity-runtime.mjs
node scripts/test-sanity-runtime.mjs --leftover-vendor-env
payment_scenarios=a1-paypal-normal-client-cron,a1-razorpay-normal-client-cron,a1-dodo-normal-client-cron,a1-free-normal-client-cron,a1-paypal-normal-client-webhook,a1-razorpay-normal-client-webhook
legacy_scenarios=paypal-refund-up-link,paypal-reversal-resource-capture,a2-f6-dodo-dispute_opened,a2-f6-dodo-dispute_lost
ROO_PAYMENT_PERSISTENCE_ARTIFACT=test-results/sanity-runtime/payment-absent.json node scripts/test-payment-persistence-sweep.mjs --full-chain --scenario="$payment_scenarios"
ROO_PAYMENT_PERSISTENCE_ARTIFACT=test-results/sanity-runtime/payment-leftovers.json node scripts/test-payment-persistence-sweep.mjs --full-chain --leftover-vendor-env --scenario="$payment_scenarios"
ROO_PAYMENT_PERSISTENCE_ARTIFACT=test-results/sanity-runtime/payment-legacy-owner-absent.json node scripts/test-payment-persistence-sweep.mjs --full-chain --legacy-owner --a2 --scenario="$legacy_scenarios"
ROO_PAYMENT_PERSISTENCE_ARTIFACT=test-results/sanity-runtime/payment-legacy-owner-leftovers.json node scripts/test-payment-persistence-sweep.mjs --full-chain --leftover-vendor-env --legacy-owner --a2 --scenario="$legacy_scenarios"
bash scripts/test-sanity-sql-release.sh
affected=(
  src/__tests__/bookingApi.test.js
  src/__tests__/bookingAvailability.test.js
  src/__tests__/bookingHoldBackendOutage.test.js
  src/__tests__/commerceReadinessReferralEmail.test.js
  src/__tests__/commerceReadinessRoute.test.js
  src/__tests__/contentPrivacyBoundary.test.js
  src/__tests__/credentialRecovery.test.js
  src/__tests__/downloadAccess.test.js
  src/__tests__/downloadRateLimitBackend.test.js
  src/__tests__/getUpgradeInfo.test.js
  src/__tests__/homeSectionHydration.test.jsx
  src/__tests__/homepageBenchmarks.test.jsx
  src/__tests__/markdownNegotiation.test.js
  src/__tests__/paymentBackendSelection.test.js
  src/__tests__/paymentSessionFlow.test.js
  src/__tests__/refHashPassword.test.js
  src/__tests__/refLoginApi.test.js
  src/__tests__/refPayoutBackendSelection.test.js
  src/__tests__/refRecoverPasswordApi.test.js
  src/__tests__/refRegisterConcurrency.test.js
  src/__tests__/refResetConcurrency.test.js
  src/__tests__/referralFallbackReadinessRoute.test.js
  src/__tests__/routeRenderer.test.js
  src/__tests__/runtimeEnvValidation.test.js
  src/__tests__/sanityClient.test.js
  src/__tests__/sanityServerAuthority.test.js
  src/__tests__/supabaseAccounts.test.js
  src/__tests__/supabaseShadow.test.js
  src/__tests__/uiAccessibility.test.jsx
  src/__tests__/signedTokenCanonicality.test.js
  src/__tests__/appBrowserHistory.test.jsx
)
npx jest "${affected[@]}" --runInBand --json --outputFile=test-results/sanity-runtime/jest-affected.json
