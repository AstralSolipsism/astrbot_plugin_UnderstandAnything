import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile } from "vite";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(scriptDir, "..");
const runtimeRoot = path.resolve(dashboardRoot, "../..");
const pluginRoot = path.resolve(runtimeRoot, "..");
const distDir = path.resolve(dashboardRoot, "dist");
const pluginPageDir = path.resolve(pluginRoot, "pages", "dashboard");

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function relativeAssetUrl(fromDir, filePath) {
  return `./${toPosixPath(path.relative(fromDir, filePath))}`;
}

async function findRequiredFile(root, predicate, label) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const match = await findRequiredFile(fullPath, predicate, label).catch(
        () => null,
      );
      if (match) return match;
      continue;
    }
    if (entry.isFile() && predicate(entry.name, fullPath)) return fullPath;
  }
  throw new Error(`Built dashboard ${label} was not found in ${root}`);
}

async function renderPluginPageHtml() {
  const templatePath = path.join(dashboardRoot, "index.html");
  const template = await fs.readFile(templatePath, "utf8");
  const scriptPath = await findRequiredFile(
    distDir,
    (name) => name === "index-classic.js",
    "classic script",
  );
  const cssPath = await findRequiredFile(
    distDir,
    (name) => name.endsWith(".css"),
    "stylesheet",
  );
  const scriptUrl = relativeAssetUrl(distDir, scriptPath);
  const cssUrl = relativeAssetUrl(distDir, cssPath);
  const stylesheetTag = `    <link rel="stylesheet" href="${cssUrl}" />`;
  const scriptTag = `    <script src="${scriptUrl}"></script>`;
  const devEntryScript = '    <script type="module" src="/src/main.tsx"></script>';

  let html = template.replaceAll('href="/favicon.svg"', 'href="./favicon.svg"');
  html = html.replace(devEntryScript, scriptTag);
  if (!html.includes(scriptTag)) {
    throw new Error("Failed to replace dashboard module entry script");
  }
  html = html.replace("\n  </head>", `\n${stylesheetTag}\n  </head>`);
  return html;
}

function assertSafePluginPageTarget() {
  const relativeToPluginRoot = path.relative(pluginRoot, pluginPageDir);
  if (
    !relativeToPluginRoot ||
    relativeToPluginRoot.startsWith("..") ||
    path.isAbsolute(relativeToPluginRoot) ||
    toPosixPath(relativeToPluginRoot) !== "pages/dashboard"
  ) {
    throw new Error(`Refusing to sync unexpected plugin page path: ${pluginPageDir}`);
  }
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function syncPluginPageOutput() {
  assertSafePluginPageTarget();
  await fs.rm(pluginPageDir, { recursive: true, force: true });
  await copyDirectory(distDir, pluginPageDir);
}

async function buildPluginPage() {
  process.env.NODE_ENV = "production";
  const loadedConfig = await loadConfigFromFile(
    { command: "build", mode: "production" },
    path.join(dashboardRoot, "vite.config.ts"),
  );
  if (!loadedConfig) {
    throw new Error("Failed to load dashboard Vite config");
  }

  const baseConfig = loadedConfig.config;
  await build({
    root: dashboardRoot,
    configFile: false,
    base: "./",
    plugins: baseConfig.plugins,
    resolve: baseConfig.resolve,
    define: {
      ...(baseConfig.define ?? {}),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    publicDir: baseConfig.publicDir,
    build: {
      outDir: distDir,
      emptyOutDir: true,
      cssCodeSplit: false,
      modulePreload: false,
      minify: "esbuild",
      target: baseConfig.build?.target ?? "es2020",
      lib: {
        entry: path.join(dashboardRoot, "src", "main.tsx"),
        name: "UnderstandAnythingDashboard",
        formats: ["iife"],
        fileName: () => "assets/index-classic.js",
      },
    },
  });

  const html = await renderPluginPageHtml();
  await fs.writeFile(path.join(distDir, "index.html"), html, "utf8");
  await syncPluginPageOutput();
}

buildPluginPage().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
