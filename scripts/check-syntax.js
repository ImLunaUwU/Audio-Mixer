// Syntax-checks every JS file (CommonJS for main/preload, ES modules for the renderer).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const files = [];
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) walk(full);
  else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) files.push(full);
});
["src", "test", "scripts"].forEach(dir => walk(path.join(root, dir)));
files.push(path.join(root, "forge.config.js"));

let failed = 0;
for (const file of files) {
  const isModule = file.includes(`${path.sep}renderer${path.sep}`) || file.endsWith(".mjs");
  try {
    execFileSync(process.execPath, isModule ? ["--input-type=module", "--check"] : ["--check", file], {
      input: isModule ? fs.readFileSync(file) : undefined,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (error) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}\n${error.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
