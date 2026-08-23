// Parses every TypeScript source file in the workspace. There is no type
// checker yet; this at least guarantees nothing unparseable is committed and
// removes the hand-maintained file list the previous script carried.
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";

const roots = ["apps", "packages", "scripts"];
const skipDirectories = new Set(["node_modules", ".git", "migrations"]);

async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      files.push(...(await collect(`${directory}/${entry.name}`)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(`${directory}/${entry.name}`);
    }
  }
  return files;
}

const files = (await Promise.all(roots.map(collect))).flat().sort();
if (files.length === 0) {
  console.error("No TypeScript sources found. The check script is misconfigured.");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", "--check", file], { stdio: "pipe" });
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${file}\n${error.stderr?.toString() ?? error.message}`);
  }
}

console.log(`Checked ${files.length} file(s), ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
