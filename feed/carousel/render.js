#!/usr/bin/env node
/**
 * 묘연 타로 도감 — 캐러셀 렌더러 (HTML → PNG)
 * insta_design(insta-carousel-builder)의 html-carousel-gen.js를 묘연 구조로 재구성.
 *
 * slides 폴더의 *.html을 1080×1350 (2x 레티나) PNG로 캡처.
 * 한글 100% 정확 · 비용 0원 · 결정적 결과 — 22장 시리즈 일관성 유지용.
 *
 * 사용법:
 *   node feed/carousel/render.js --card 00_fool          # 7장 전체
 *   node feed/carousel/render.js --card 00_fool --only 3 # slide-03만
 *
 * 입력:  feed/carousel/output/<card>/slides/slide-01~07.html
 * 출력:  feed/carousel/output/<card>/slide-01~07.png
 */
import puppeteer from "puppeteer";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG = { width: 1080, height: 1350, deviceScaleFactor: 2 };

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--") && argv[i + 1]) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.card) {
    console.error("사용법: node feed/carousel/render.js --card <폴더명>  (예: 00_fool)");
    process.exit(1);
  }
  const cardDir = join(__dirname, "output", args.card);
  const slidesDir = join(cardDir, "slides");
  if (!existsSync(slidesDir)) {
    console.error(`❌ slides 폴더 없음: ${slidesDir}`);
    process.exit(1);
  }

  let files = readdirSync(slidesDir).filter((f) => f.endsWith(".html")).sort();
  if (args.only) {
    const target = `slide-${String(args.only).padStart(2, "0")}.html`;
    files = files.filter((f) => f === target);
  }
  if (!files.length) {
    console.error("❌ 캡처할 HTML이 없습니다.");
    process.exit(1);
  }

  console.log(`\n${args.card} — ${files.length}장 캡처 시작\n`);
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
  await page.setViewport(CONFIG);

  for (const file of files) {
    const fileUrl = "file:///" + resolve(slidesDir, file).replace(/\\/g, "/");
    await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 500)); // 폰트/이미지 안정화
    const outPath = join(cardDir, file.replace(".html", ".png"));
    await page.screenshot({
      path: outPath, type: "png",
      clip: { x: 0, y: 0, width: CONFIG.width, height: CONFIG.height },
    });
    console.log(`  ✓ ${file.replace(".html", ".png")}`);
  }

  await browser.close();
  console.log(`\n완료! ${cardDir}\n`);
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
