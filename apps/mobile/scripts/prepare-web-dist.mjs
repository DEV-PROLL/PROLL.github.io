import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(projectRoot, "dist");
const publicDir = join(projectRoot, "public");

await mkdir(distDir, { recursive: true });
await copyFile(join(publicDir, "manifest.json"), join(distDir, "manifest.json"));
await copyFile(join(publicDir, "icon.svg"), join(distDir, "icon.svg"));
await copyFile(
  join(publicDir, "service-worker.js"),
  join(distDir, "service-worker.js"),
);

const indexPath = join(distDir, "index.html");
let html = await readFile(indexPath, "utf8");
const bridgeUrl = process.env.EXPO_PUBLIC_BRIDGE_URL?.trim();

if (!html.includes('rel="manifest"')) {
  html = html.replace(
    "</head>",
    [
      '  <link rel="manifest" href="/manifest.json">',
      '  <link rel="icon" href="/icon.svg" type="image/svg+xml">',
      '  <link rel="apple-touch-icon" href="/icon.svg">',
      '  <meta name="apple-mobile-web-app-capable" content="yes">',
      '  <meta name="apple-mobile-web-app-title" content="PROLL">',
      '  <meta name="mobile-web-app-capable" content="yes">',
      "</head>",
    ].join("\n"),
  );
}

if (!html.includes("serviceWorker.register")) {
  html = html.replace(
    "</body>",
    [
      "  <script>",
      '    if ("serviceWorker" in navigator) {',
      '      window.addEventListener("load", function () {',
      '        navigator.serviceWorker.register("/service-worker.js").catch(function () {});',
      "      });",
      "    }",
      "  </script>",
      "</body>",
    ].join("\n"),
  );
}

html = html.replace(
  /\n?  <script id="rudulgi-runtime-config">[\s\S]*?<\/script>/,
  "",
);

if (bridgeUrl) {
  html = html.replace(
    "</head>",
    [
      '  <script id="rudulgi-runtime-config">',
      `    window.__RUDULGI_BRIDGE_URL__ = ${JSON.stringify(bridgeUrl)};`,
      "  </script>",
      "</head>",
    ].join("\n"),
  );
}

await writeFile(indexPath, html);
