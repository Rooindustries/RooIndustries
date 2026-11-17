#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import operatorEnvironment from "./lib/operator-environment.cjs";
import { CMS_STORAGE_TRANSFER_TIMEOUT_MS } from "../src/server/cms/assets.js";
import { fillImageSizes, imagesToFill } from "../src/server/cms/imageSizeFill.js";
import { assertGlobalCmsWritesAllowed } from "../src/server/cms/writeControl.js";
import { createSupabaseAdminClient, resolveSupabaseAdminEnv } from "../src/server/supabase/adminClient.js";

const USAGE = `Usage: node scripts/fill-image-sizes.mjs --env <private-file> [--apply] [--report <file>] [--save-sizes <dir>]

For every image with no recorded sizes: makes the sizes, stores them, then records them.
It never deletes or overwrites a stored file, and it is safe to run again.
Only a vector or an animated image is recorded with no sizes. An image that cannot be read or decoded
fails with its reason and nothing is recorded for it; any failed image makes the run exit 1.

  --env <private-file>  the operator environment file holding SUPABASE_URL and SUPABASE_SECRET_KEY
  --apply               store and record the sizes; needs CMS_WRITES_PAUSED=0 in the shell
                        without it nothing is written: the sizes are made in memory and the plan is listed
  --report <file>       write every image's outcome as JSON to a file that does not exist yet
  --save-sizes <dir>    keep a copy of the made size files in this folder
  --help                show this text`;
const VALUE_OPTIONS = ["--env", "--report", "--save-sizes"];
const FLAGS = ["--apply", "--help"];
const IMAGES_AT_ONCE = 2;
const OUTCOMES = { apply: ["filled", "already filled", "recorded empty", "failed", "missing", "no document"], plan: ["to fill", "already filled", "to record empty", "failed", "missing", "no document"] };
const UNFINISHED = ["failed", "missing", "no document"];

const readOptions = (args) => {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (FLAGS.includes(name)) options[name] = true;
    else if (VALUE_OPTIONS.includes(name) && value && !value.startsWith("--")) options[name] = args[++index];
    else throw new Error(`Unsupported or incomplete option: ${name}\n\n${USAGE}`);
  }
  return options;
};

const main = async () => {
  const options = readOptions(process.argv.slice(2));
  if (options["--help"]) { console.log(USAGE); return 0; }
  operatorEnvironment.loadOperatorEnvironment(options["--env"]);
  const apply = options["--apply"] === true;
  if (apply) {
    try { assertGlobalCmsWritesAllowed(process.env); }
    catch (error) { throw Object.assign(error, { message: `${error.message} --apply needs CMS_WRITES_PAUSED=0 in the shell.` }); }
  }
  const target = new URL(resolveSupabaseAdminEnv(process.env).url).host;
  const client = createSupabaseAdminClient({ env: process.env, storageTransferTimeoutMs: CMS_STORAGE_TRANSFER_TIMEOUT_MS });
  const report = options["--report"] ? fs.openSync(options["--report"], "wx", 0o600) : null;
  const sizesFolder = options["--save-sizes"];
  if (sizesFolder) fs.mkdirSync(sizesFolder, { recursive: true });
  const summary = Object.fromEntries(OUTCOMES[apply ? "apply" : "plan"].map((outcome) => [outcome, 0]));
  const images = [];
  console.log(apply ? `Filling image sizes on ${target}.` : `Dry run on ${target}: nothing is written.`);
  const pending = imagesToFill(client);
  const work = async () => {
    for await (const image of pending) {
      const { files = [], ...result } = await fillImageSizes({ client, image, apply });
      if (sizesFolder) for (const file of files) fs.writeFileSync(path.join(sizesFolder, path.basename(file.path)), file.bytes);
      summary[result.outcome] += 1;
      images.push({ id: image.id, path: image.storage_path, ...result });
      console.log(`${image.id} ${result.outcome}${result.sizes?.length ? ` ${result.sizes.join(",")}` : ""}${result.reason ? `: ${result.reason}` : ""}`);
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: IMAGES_AT_ONCE }, work));
  console.log(Object.entries(summary).map(([outcome, count]) => `${outcome} ${count}`).join(", "));
  if (report !== null) { fs.writeFileSync(report, `${JSON.stringify({ target, apply, summary, images }, null, 2)}\n`); fs.closeSync(report); }
  const crashed = workers.find((worker) => worker.status === "rejected");
  if (crashed) throw crashed.reason;
  return UNFINISHED.some((outcome) => summary[outcome] > 0) ? 1 : 0;
};

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(error.message.startsWith(`${error.code}:`) ? error.message : `${error.code || "ERROR"}: ${error.message}`);
  process.exitCode = 1;
});
