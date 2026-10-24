import { registerHooks } from "node:module";

const actual = import.meta.resolve("postgres");
const wrapper = `
  import postgres from ${JSON.stringify(actual)};
  import fs from "node:fs";
  import path from "node:path";
  export default (...args) => {
    const sql = postgres(...args);
    const end = sql.end;
    sql.end = async (...options) => {
      await end(...options);
      if (process.env.ROO_CLOSE_FIXTURE_MODE === "remove") {
        const parent = path.join(process.env.ROO_JOB_DIR, "tmp");
        const clusters = fs.readdirSync(parent).filter(name => name.startsWith("roo-account-domain-"));
        if (clusters.length !== 1) throw new Error("Cleanup fixture cluster ownership mismatch");
        fs.chmodSync(path.join(parent, clusters[0]), 0o500);
      }
      throw new Error("fixture-client-close-failure");
    };
    return sql;
  };
`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "postgres" && context.parentURL?.endsWith("/scripts/test-account-domain-identity-postgres.mjs")) {
    return { url: `data:text/javascript,${encodeURIComponent(wrapper)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
