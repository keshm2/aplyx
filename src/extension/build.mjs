// Build the Manifest V3 extension into dist/ (load-unpacked target).
// esbuild bundles each entry point; static files are copied verbatim.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    options: "src/options.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: false,
  logLevel: "info",
});

for (const file of ["manifest.json", "options.html"]) {
  cpSync(`src/${file}`, `dist/${file}`);
}
