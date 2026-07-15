import connectionTarget from "./postgres-connection-target.cjs";

export const buildPostgresConnectionEnv =
  connectionTarget.buildPostgresConnectionEnv;
export const buildPostgresConnectionOptions =
  connectionTarget.buildPostgresConnectionOptions;
export const buildPostgresSessionArgs =
  connectionTarget.buildPostgresSessionArgs;
