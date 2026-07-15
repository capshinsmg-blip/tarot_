#!/usr/bin/env node
/**
 * 메타 광고 포스터 렌더러 (HTML → PNG)
 * feed/carousel/render.js와 동일한 puppeteer 방식. 광고 소재는 4:5(1080×1350)로 렌더.
 *
 * 사용법:  node feed/ads/render.js poster_v1        # feed/ads/poster_v1.html → poster_v1.png
 * 크기 옵션: node feed/ads/render.js poster_v1 1080 1080   # 1:1 정사각
 */
import puppeteer from "puppeteer";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] || "poster_v1";
const width = Number(process.argv[3]) || 1080;
const height = Number(process.argv[4]) || 1350;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: 2 });
const fileUrl = "file:///" + resolve(__dirname, `${name}.html`).replace(/\\/g, "/");
await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 20000 });
await page.evaluate(() => document.fonts.ready);
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: resolve(__dirname, `${name}.png`), type: "png", clip: { x: 0, y: 0, width, height } });
await browser.close();
console.log(`✓ ${name}.png (${width}×${height})`);
