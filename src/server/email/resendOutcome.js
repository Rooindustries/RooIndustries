export const wasPreviouslyAccepted = (result) =>
  result?.error?.name === "invalid_idempotent_request" &&
  Number(result.error.statusCode) === 409;
