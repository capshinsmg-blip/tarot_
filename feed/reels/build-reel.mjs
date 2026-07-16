#!/usr/bin/env node
/**
 * 묘연이 릴스 조립기 — 클립 뱅크 + 한글 자막 오버레이 → 발행용 mp4
 *
 * 1) 자막을 브랜드 폰트(Gowun Batang/Pretendard)로 투명 PNG 렌더 (puppeteer)
 * 2) ffmpeg(ffmpeg-static)으로 클립 concat + 구간별 오버레이 → 720×1280 무음 mp4
 *    (오디오는 인스타 업로드 시 트렌딩 음원을 얹는다 — 알고리즘상 유리)
 *
 * 사용법:  node feed/reels/build-reel.mjs feed/reels/configs/reel01_r2.json
 */
import puppeteer from "puppeteer";
import ffmpegPath from "ffmpeg-static";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const W = 720, H = 1280;

const cfgPath = resolve(process.argv[2] || "");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

/* ── 1. 자막 오버레이 PNG 렌더 ── */
function subHtml(sub) {
  // 릴스 UI 안전영역: 상단 ~180px(음원 표시)·하단 ~330px(캡션/버튼) 회피
  const pos = sub.style === "cta" ? "bottom:420px" : "top:236px";
  const typo = sub.style === "hook"
    ? "font-family:'Gowun Batang',serif;font-size:52px;font-weight:700;line-height:1.5"
    : sub.style === "cta"
      ? "font-family:'Gowun Batang',serif;font-size:42px;font-weight:700;line-height:1.55"
      : "font-family:'Pretendard Variable','Pretendard',sans-serif;font-size:37px;font-weight:600;line-height:1.6";
  const handle = sub.handle
    ? `<div style="margin-top:14px;font-family:'Pretendard Variable','Pretendard',sans-serif;font-size:26px;font-weight:700;color:#E9B96E;letter-spacing:.04em">@myoyeon.tarot</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<style>
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/variable/pretendardvariable.css');
@import url('https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap');
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${W}px; height:${H}px; background:transparent; overflow:hidden; word-break:keep-all; }
b { color:#E9B96E; font-weight:inherit; }
</style></head>
<body>
  <div style="position:absolute;left:0;right:0;${pos};display:flex;flex-direction:column;align-items:center;padding:0 44px">
    <div style="background:rgba(12,15,34,0.58);border:1px solid rgba(233,185,110,0.28);border-radius:20px;padding:20px 30px;text-align:center;color:#F6EFE3;${typo};text-shadow:0 2px 14px rgba(0,0,0,.45)">
      ${sub.text}
    </div>
    ${handle}
  </div>
</body></html>`;
}

const overlayDir = join(__dirname, "overlays", cfg.name);
mkdirSync(overlayDir, { recursive: true });
mkdirSync(join(__dirname, "output"), { recursive: true });

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const overlayPngs = [];
for (let i = 0; i < cfg.subs.length; i++) {
  await page.setContent(subHtml(cfg.subs[i]), { waitUntil: "load", timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 600));
  const out = join(overlayDir, `sub-${String(i + 1).padStart(2, "0")}.png`);
  await page.screenshot({ path: out, type: "png", omitBackground: true });
  overlayPngs.push(out);
  console.log("  ✓ overlay", out.split(/[\\/]/).pop());
}
await browser.close();

/* ── 2. ffmpeg 조립 ── */
const args = ["-y", "-loglevel", "error"];
for (const clip of cfg.clips) args.push("-i", resolve(__dirname, clip));
// PNG는 -t로 유한 스트림으로 제한 (무한 루프 인코딩 방지)
for (const png of overlayPngs) args.push("-loop", "1", "-t", "15", "-i", png);

const n = cfg.clips.length;
let fc = "";
for (let i = 0; i < n; i++) fc += `[${i}:v]fps=30,scale=${W}:${H},setsar=1[c${i}];`;
fc += cfg.clips.map((_, i) => `[c${i}]`).join("") + `concat=n=${n}:v=1:a=0[base];`;
let cur = "base";
cfg.subs.forEach((sub, i) => {
  const next = i === cfg.subs.length - 1 ? "vout" : `v${i + 1}`;
  fc += `[${cur}][${n + i}:v]overlay=0:0:enable='between(t,${sub.from},${sub.to})'[${next}];`;
  cur = next;
});
fc = fc.slice(0, -1); // 마지막 세미콜론 제거

const outPath = join(__dirname, "output", `${cfg.name}.mp4`);
execFileSync(ffmpegPath, [
  ...args,
  "-filter_complex", fc,
  "-map", "[vout]",
  "-t", String(cfg.out_duration || 15), // 출력 길이 캡 (2중 안전장치)
  "-c:v", "libx264", "-preset", "medium", "-crf", "20",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
  outPath,
], { stdio: ["ignore", "inherit", "inherit"] });

console.log(`\n✓ ${cfg.name}.mp4 완성 → feed/reels/output/`);
