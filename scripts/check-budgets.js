const fs = require("fs");
const path = require("path");

const maxInitialJsBytes = 250 * 1024;
const maxMediaBytes = 25 * 1024 * 1024;

const errors = [];

const nextChunkDir = path.join(process.cwd(), ".next", "static", "chunks");
if (fs.existsSync(nextChunkDir)) {
  const chunkFiles = fs
    .readdirSync(nextChunkDir)
    .filter((name) => name.endsWith(".js"));

  const appChunk = chunkFiles.find((name) => name.startsWith("main-app"));
  if (appChunk) {
    const size = fs.statSync(path.join(nextChunkDir, appChunk)).size;
    if (size > maxInitialJsBytes) {
      errors.push(
        `Initial app JS chunk is ${size} bytes (budget ${maxInitialJsBytes}).`
      );
    }
  }
}

const publicDir = path.join(process.cwd(), "public");
const walk = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }

    if (!/\.(mp4|webm|png|jpg|jpeg|webp|avif)$/i.test(entry.name)) continue;
    const rel = path.relative(process.cwd(), abs).replace(/\\/g, "/");
    const size = fs.statSync(abs).size;

    if (size > maxMediaBytes) {
      errors.push(`${rel} is ${size} bytes (budget ${maxMediaBytes}).`);
    }
  }
};

if (fs.existsSync(publicDir)) {
  walk(publicDir);
}

if (errors.length) {
  console.error("Performance budget checks failed:\n");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log("Performance budgets passed.");
