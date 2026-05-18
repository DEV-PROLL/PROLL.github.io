import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(projectRoot, "dist");
const publicDir = join(projectRoot, "public");

await mkdir(distDir, { recursive: true });
await copyFile(join(publicDir, "manifest.json"), join(distDir, "manifest.json"));
await copyFile(join(publicDir, "icon.svg"), join(distDir, "icon.svg"));
await copyFile(join(publicDir, "CNAME"), join(distDir, "CNAME"));
await copyFile(
  join(publicDir, "service-worker.js"),
  join(distDir, "service-worker.js"),
);

const indexPath = join(distDir, "index.html");
let html = await readFile(indexPath, "utf8");
const bridgeUrl = process.env.EXPO_PUBLIC_BRIDGE_URL?.trim();
const appTitle = "루둘기 앱";

if (!html.includes('rel="manifest"')) {
  html = html.replace(
    "</head>",
    [
      '  <link rel="manifest" href="./manifest.json">',
      '  <link rel="icon" href="./icon.svg" type="image/svg+xml">',
      '  <link rel="apple-touch-icon" href="./icon.svg">',
      '  <meta name="apple-mobile-web-app-capable" content="yes">',
      `  <meta name="apple-mobile-web-app-title" content="${appTitle}">`,
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
      '        navigator.serviceWorker.register("./service-worker.js").catch(function () {});',
      "      });",
      "    }",
      "  </script>",
      "</body>",
    ].join("\n"),
  );
}

html = html
  .replaceAll('href="/manifest.json"', 'href="./manifest.json"')
  .replaceAll('href="/icon.svg"', 'href="./icon.svg"')
  .replaceAll('src="/_expo/', 'src="./_expo/')
  .replaceAll('navigator.serviceWorker.register("/service-worker.js")', 'navigator.serviceWorker.register("./service-worker.js")');

if (/<title>[\s\S]*?<\/title>/.test(html)) {
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${appTitle}</title>`);
} else {
  html = html.replace("</head>", `  <title>${appTitle}</title>\n</head>`);
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
