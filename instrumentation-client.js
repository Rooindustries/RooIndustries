import { reportClientError, watchWindowErrors } from "./src/lib/monitoring/client";

watchWindowErrors();

window.addEventListener("checkout-draft-error", () => {
  reportClientError(new Error("Failed to read saved checkout draft"));
});
