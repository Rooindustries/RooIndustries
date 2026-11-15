import fs from "node:fs";
import path from "node:path";

const forbidden = /\berrcode\s*=\s*(?:\(\s*)*(?:'(?:40001|40p01|serialization_failure|deadlock_detected)'|[a-z_][a-z_0-9.]*)|\braise\s+sqlstate\s+'40[a-z0-9]{3}'|\braise\s+(?:exception\s+)?(?:serialization_failure|deadlock_detected)\b|\bwhen\s+(?:serialization_failure|deadlock_detected)\b/gi;
const extensions = new Set([".sql", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".bash"]);

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name);
  if (entry.isDirectory()) return walk(file);
  return entry.isFile() && extensions.has(path.extname(entry.name)) ? [file] : [];
});

export const retrySqlFailures = (migrationsDirectory, migrationFiles) => {
  const files = [
    ...migrationFiles.filter((name) => name > "20261115000000_return_deliberate_conflicts_at_once.sql").map((name) => path.join(migrationsDirectory, name)),
    ...walk("scripts"),
    ...walk("tests"),
  ];
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    return [...source.matchAll(forbidden)].map((match) => {
      const line = source.slice(0, match.index).split("\n").length;
      return `${file}:${line}: retry SQLSTATE in raised error`;
    });
  });
};
