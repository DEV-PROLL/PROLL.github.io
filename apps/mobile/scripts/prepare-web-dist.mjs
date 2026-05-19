import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(projectRoot, "dist");
const publicDir = join(projectRoot, "public");

await mkdir(distDir, { recursive: true });
await copyFile(join(publicDir, "manifest.json"), join(distDir, "manifest.json"));
await copyFile(join(publicDir, "icon.svg"), join(distDir, "icon.svg"));
await copyFile(join(publicDir, "icon-180.png"), join(distDir, "icon-180.png"));
await copyFile(join(publicDir, "icon-192.png"), join(distDir, "icon-192.png"));
await copyFile(join(publicDir, "icon-512.png"), join(distDir, "icon-512.png"));
await copyFile(
  join(publicDir, "icon-maskable-512.png"),
  join(distDir, "icon-maskable-512.png"),
);
await copyFile(join(publicDir, "CNAME"), join(distDir, "CNAME"));
await copyFile(
  join(publicDir, "service-worker.js"),
  join(distDir, "service-worker.js"),
);

const indexPath = join(distDir, "index.html");
let html = await readFile(indexPath, "utf8");
const bridgeUrl = process.env.EXPO_PUBLIC_BRIDGE_URL?.trim();
const appName = "루둘기";
const appTitle = "루둘기 - 99999.kr";
const metaTags = [
  '  <link rel="manifest" href="./manifest.json" data-rudulgi-meta="true">',
  '  <link rel="icon" href="./icon.svg" type="image/svg+xml" data-rudulgi-meta="true">',
  '  <link rel="apple-touch-icon" sizes="180x180" href="./icon-180.png" data-rudulgi-meta="true">',
  '  <meta name="application-name" content="루둘기" data-rudulgi-meta="true">',
  '  <meta name="apple-mobile-web-app-capable" content="yes" data-rudulgi-meta="true">',
  '  <meta name="apple-mobile-web-app-title" content="루둘기" data-rudulgi-meta="true">',
  '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" data-rudulgi-meta="true">',
  '  <meta name="mobile-web-app-capable" content="yes" data-rudulgi-meta="true">',
  '  <meta name="theme-color" content="#0d1117" data-rudulgi-meta="true">',
  '  <meta name="color-scheme" content="dark" data-rudulgi-meta="true">',
  '  <meta name="format-detection" content="telephone=no" data-rudulgi-meta="true">',
  `  <meta property="og:site_name" content="${appName}" data-rudulgi-meta="true">`,
  `  <meta property="og:title" content="${appTitle}" data-rudulgi-meta="true">`,
  '  <meta property="og:description" content="99999.kr Minecraft Java 채팅과 명령어." data-rudulgi-meta="true">',
  '  <meta property="og:image" content="https://app.99999.kr/icon-512.png" data-rudulgi-meta="true">',
  '  <meta property="og:url" content="https://app.99999.kr/" data-rudulgi-meta="true">',
  '  <meta name="twitter:card" content="summary" data-rudulgi-meta="true">',
];

html = html.replace(/<html lang="[^"]*"/, '<html lang="ko"');
html = html.replace(
  /<meta name="viewport" content="[^"]*" \/>/,
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
);
html = html.replace(
  /\n?  <meta name="theme-color" content="[^"]*">\n?/g,
  "\n",
);
html = html.replace(/\n?  <[^>\n]+data-rudulgi-meta="true"[^>]*>/g, "");
html = html.replace("</head>", `${metaTags.join("\n")}\n</head>`);

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
