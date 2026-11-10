import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import fs from "fs";

/**
 * Плагін для заміни значень у public/ файлах (sw.js, manifest.json)
 * на значення з .env при білді та dev-сервері
 */
function publicEnvPlugin(env: Record<string, string>) {
  const projectName = env.VITE_PROJECT_NAME || "sto";
  const appName = env.VITE_APP_NAME || projectName;
  const appDescription = env.VITE_APP_DESCRIPTION || "";

  function processSwJs(content: string): string {
    return content
      .replace(
        /const CACHE_NAME = '[^']+';/,
        `const CACHE_NAME = '${projectName}-cache-v9';`,
      )
      .replace(
        /const CACHE_CDN = '[^']+';/,
        `const CACHE_CDN = '${projectName}-cdn-v9';`,
      );
  }

  function processManifest(content: string): string {
    const manifest = JSON.parse(content);
    manifest.name = appName;
    manifest.short_name = appName;
    manifest.description = appDescription;
    return JSON.stringify(manifest, null, 2);
  }

  return {
    name: "public-env-replace",
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (req.url === "/sw.js") {
          const filePath = resolve("public/sw.js");
          if (fs.existsSync(filePath)) {
            res.setHeader("Content-Type", "application/javascript");
            res.end(processSwJs(fs.readFileSync(filePath, "utf-8")));
            return;
          }
        }
        if (req.url === "/manifest.json") {
          const filePath = resolve("public/manifest.json");
          if (fs.existsSync(filePath)) {
            res.setHeader("Content-Type", "application/json");
            res.end(processManifest(fs.readFileSync(filePath, "utf-8")));
            return;
          }
        }
        next();
      });
    },
    writeBundle(options: any) {
      const outDir = options.dir || "dist";

      const swPath = resolve(outDir, "sw.js");
      if (fs.existsSync(swPath)) {
        fs.writeFileSync(swPath, processSwJs(fs.readFileSync(swPath, "utf-8")));
      }

      const manifestPath = resolve(outDir, "manifest.json");
      if (fs.existsSync(manifestPath)) {
        fs.writeFileSync(
          manifestPath,
          processManifest(fs.readFileSync(manifestPath, "utf-8")),
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const githubRepo = env.VITE_GITHUB_REPO || "";

  return {
    base: process.env.DEPLOY_TARGET === "github" ? `/${githubRepo}/` : "/",
    plugins: [react(), publicEnvPlugin(env)],
    build: {
      modulePreload: false,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
          main: resolve(__dirname, "main.html"),
          bukhhalteriya: resolve(__dirname, "bukhhalteriya.html"),
          planyvannya: resolve(__dirname, "planyvannya.html"),
        },
        output: {
          manualChunks(id) {
            const normalizedId = id.replace(/\\/g, "/");

            // Vite preload helper — в окремий chunk для уникнення кругових залежностей
            if (
              normalizedId.includes("modulepreload-polyfill") ||
              normalizedId.includes("preload-helper") ||
              normalizedId.includes("commonjsHelpers")
            )
              return "vendor";

            // Supabase — окремий chunk (великий, рідко змінюється)
            if (normalizedId.includes("/node_modules/@supabase/"))
              return "supabase";

            // PDF генерація — завантажується тільки при друку
            if (
              normalizedId.includes("/node_modules/jspdf/") ||
              normalizedId.includes("/node_modules/html2canvas/")
            )
              return "pdf";

            // React — окремо
            if (
              normalizedId.includes("/node_modules/react-dom/") ||
              normalizedId.includes("/node_modules/react/")
            )
              return "react";

            // Графіки — великий сторонній пакет, ізольовуємо від коду застосунку.
            if (normalizedId.includes("/node_modules/apexcharts/"))
              return "charts";

            // Only the date libraries belong here. Keep daterangepicker in its
            // dynamic chunk: its UMD factory must run AFTER window.moment and
            // window.jQuery are assigned by ensureBrowserDateGlobals().
            if (
              normalizedId.includes("/node_modules/jquery/") ||
              normalizedId.includes("/node_modules/moment/")
            )
              return "date-vendor";

            // Let Rollup split application modules by their real entry points.
            // Folder-based chunks pulled shared auth/config dependencies AND
            // auto-running protected-page guards into the public login page,
            // causing index -> main -> index redirect loops before sign-in.
            // Keep only third-party libraries in manually assigned chunks.
          },
        },
      },
    },
  };
});
