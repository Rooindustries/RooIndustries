import { createClient } from "@sanity/client";

export const DEFAULT_BOOKING_STATE_DATASET = "production";

const readFirstEnv = (keys = []) =>
  keys
    .map((key) => String(process.env[key] || "").trim())
    .find((value) => value.length > 0) || "";

export const resolveBookingStateDataset = () =>
  readFirstEnv([
    "BOOKING_STATE_SANITY_DATASET",
    "BOOKING_SANITY_DATASET",
    "SANITY_BOOKING_DATASET",
  ]) || DEFAULT_BOOKING_STATE_DATASET;

const resolveProjectId = () =>
  readFirstEnv([
    "SANITY_PRIVATE_PROJECT_ID",
    "SANITY_PROJECT_ID",
    "NEXT_PUBLIC_SANITY_PROJECT_ID",
  ]) || "9g42k3ur";

const resolveApiVersion = () =>
  readFirstEnv([
    "SANITY_PRIVATE_API_VERSION",
    "SANITY_API_VERSION",
    "NEXT_PUBLIC_SANITY_API_VERSION",
  ]) || "2023-10-01";

const resolveReadToken = () =>
  readFirstEnv(["SANITY_PRIVATE_READ_TOKEN", "SANITY_READ_TOKEN"]);

const resolveWriteToken = () =>
  readFirstEnv(["SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN"]);

export const createBookingStateReadClient = () =>
  createClient({
    projectId: resolveProjectId(),
    dataset: resolveBookingStateDataset(),
    apiVersion: resolveApiVersion(),
    token: resolveReadToken() || undefined,
    useCdn: false,
  });

export const createBookingStateWriteClient = () =>
  createClient({
    projectId: resolveProjectId(),
    dataset: resolveBookingStateDataset(),
    apiVersion: resolveApiVersion(),
    token: resolveWriteToken() || undefined,
    useCdn: false,
  });
