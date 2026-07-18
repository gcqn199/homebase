#!/usr/bin/env node
/* Homebase Passdown build script.
   Bundles src/app.jsx + src/styles.css into index.html and bumps the sw.js cache version.
   Usage:  node build.mjs        (requires Node 18+; fetches esbuild via npx on first run)
   Always edit src/ — never index.html directly — then run this and commit ALL changed files. */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";

const BUNDLE = ".build_bundle.js";

// 0. first run: install pinned deps (react, react-dom, esbuild) from package.json
if (!existsSync("node_modules/react")) {
  console.log("Installing build dependencies (one-time)…");
  execSync("npm install", { stdio: "inherit" });
}

// 1. bundle the app
execSync(
  `npx esbuild src/app.jsx --bundle --minify --format=iife --jsx=automatic ` +
    `--define:process.env.NODE_ENV='"production"' --legal-comments=eof --outfile=${BUNDLE}`,
  { stdio: "inherit" }
);

// 2. assemble index.html
const css = readFileSync("src/styles.css", "utf-8");
const js = readFileSync(BUNDLE, "utf-8");
rmSync(BUNDLE);

// Compute the version number this build will ship as — same number sw.js bumps
// to below — so the header's version chip and the SW cache name always agree.
const swSrc = readFileSync("sw.js", "utf-8");
const curVerMatch = swSrc.match(/homebase-v(\d+)/);
const nextVer = curVerMatch ? Number(curVerMatch[1]) + 1 : 1;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Homebase Passdown</title>
<link rel="manifest" href="manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Homebase">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<meta name="theme-color" content="#d94f04">
<style>
${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.HOMEBASE_VERSION = "V${nextVer}";</script>
<script>
${js}</script>
<script>
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
</script>
</body>
</html>
`;
writeFileSync("index.html", html);

// 3. bump service-worker cache version so phones pick up the new build
const bumped = swSrc.replace(/homebase-v(\d+)/, () => `homebase-v${nextVer}`);
if (bumped !== swSrc) writeFileSync("sw.js", bumped);

console.log(
  `Built index.html (${(html.length / 1024).toFixed(0)} KB). ` +
    `Version: V${nextVer}. sw.js cache: homebase-v${nextVer}. Commit index.html, sw.js, and src/.`
);
