// Máy dựng template cho Brand Kit: biến một trang .ai/.pdf thành template.json + ảnh.
//
//   node scripts/build-template.mjs scripts/templates/<id>.json [--source file.ai]
//
// Vì sao làm theo cách này: bản trước chụp cả trang thành ảnh rồi "loang nền" để
// đoán đâu là nền, đâu là nhãn, đâu là chữ → mép răng cưa, chữ dính vào nhãn (mất
// ô tròn số "3.1"), icon bị tô đặc. File .ai thì đã có sẵn câu trả lời: mỗi lệnh
// vẽ thuộc một layer (BG / Layer 1…) và chữ là lệnh vẽ chữ riêng. Nên máy dựng
// đứng giữa lúc MuPDF vẽ, CHIA từng lệnh về đúng lớp của nó:
//
//   layer BG, hình phủ gần kín trang → bỏ (tool tự sinh dải nền theo màu hãng)
//   layer BG, phần còn lại           → "decor" (sóng, vệt sáng) — xoay tông
//   lệnh vẽ chữ                      → lớp chữ: đúng hình chữ gốc, mép mượt
//   mọi thứ khác                     → lớp hình
//
// Mỗi lớp vẽ ra nền TRONG SUỐT, nên mép mượt đúng như Illustrator, không phải đoán.
// Sau đó lớp hình được tách thành từng khối:
//   - box trắng lớn (minh hoạ)    → "card": ảnh gốc kèm chữ bên trong, kèm bóng đổ thật
//   - khối vài màu (nhãn + ô tròn số, icon trắng + mũi tên…) → mỗi màu một "shape"
//   - khối nhiều sắc độ (gradient) → "image", xoay tông theo hãng
// Mỗi đoạn chữ và mỗi shape ghi "on": nằm trên nền hay trên khối nào.

import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { PNG } from "pngjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cfgPath = process.argv[2];
if (!cfgPath) {
  console.error("Cách dùng: node scripts/build-template.mjs scripts/templates/<id>.json [--source file.ai]");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const srcArg = process.argv.indexOf("--source");
const source = srcArg > 0 ? process.argv[srcArg + 1] : cfg.source;
if (!source || !fs.existsSync(source)) {
  console.error(`Không thấy file nguồn: ${source}\nTruyền đường dẫn bằng --source "đường/dẫn/file.ai"`);
  process.exit(1);
}
// ×4 (~290 dpi) cho tờ rơi A4; slide khổ lớn (1440pt) chỉ cần ×2 — ×4 làm bộ slide nặng vài chục MB
const SCALE = cfg.scale || 4;
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const pageArg = argOf("--page"), outArg = argOf("--out"), noRegister = process.argv.includes("--no-register");

// Bộ slide ("pages": "all"): mỗi trang dựng bằng một tiến trình riêng (đỡ tốn bộ nhớ),
// ghi vào templates/<id>/pNN/, rồi ghi deck.json + đăng ký cả bộ là MỘT template.
if (cfg.pages && pageArg === null) {
  const d = mupdf.Document.openDocument(fs.readFileSync(source), "application/pdf");
  const n = d.countPages(), [x0, y0, x1, y1] = d.loadPage(0).getBounds();
  const root = path.join("public", "templates", cfg.id);
  fs.rmSync(root, { recursive: true, force: true });
  const list = cfg.pages === "all" ? [...Array(n).keys()] : cfg.pages;
  const pages = [];
  for (const i of list) {
    const pid = "p" + String(i + 1).padStart(2, "0");
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), cfgPath, "--page", String(i), "--out", path.join(root, pid), "--no-register"], { stdio: ["ignore", "pipe", "inherit"] });
    const log = String(r.stdout || "").split("\n").filter(Boolean);
    console.log(`[${pid}] ` + (log.find((l) => l.includes("chữ:")) || "").trim() + " | " + (log.find((l) => l.includes("card ")) || "").trim());
    if (r.status !== 0) { console.error(`trang ${i + 1} lỗi`); process.exit(1); }
    pages.push({ id: pid });
  }
  fs.writeFileSync(path.join(root, "deck.json"), JSON.stringify({ id: cfg.id, name: cfg.name, width: +(x1 - x0).toFixed(2), height: +(y1 - y0).toFixed(2), pages }, null, 1));
  const regPath = path.join("public", "templates", "index.json");
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, "utf8")) : [];
  const entry = { id: cfg.id, name: cfg.name, pages: pages.length };
  const k = reg.findIndex((q) => q.id === cfg.id);
  if (k >= 0) reg[k] = entry; else reg.push(entry);
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");
  console.log(`${cfg.id}: ${pages.length} trang → ${root}`);
  process.exit(0);
}

const bgLayer = cfg.bgLayer || "BG";
const hideLayers = new Set(cfg.hideLayers || ["Guide"]);
const outDir = outArg || path.join("public", "templates", cfg.id);
const assetDir = path.join(outDir, "assets");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(assetDir, { recursive: true });

const doc = mupdf.Document.openDocument(fs.readFileSync(source), "application/pdf");
const page = doc.loadPage(pageArg !== null ? Number(pageArg) : (cfg.page ?? 0));
// File xuất từ Canva không có layer → nhận nền bằng "hình phủ gần kín trang", không cần layer BG
const hasLayers = doc.asPDF().countLayers() > 0;
// Chữ trong card: tờ rơi D60 là nhãn nằm trong minh hoạ (giữ trong ảnh card); bộ slide thì chữ
// trong khung là tiêu đề/nội dung (vd "Clarify information") → phải vẽ lại để đổi theo brand
const bakeCardText = cfg.bakeCardText !== false;
let baseColor = null;
const [bx0, by0, bx1, by1] = page.getBounds();
const PW = bx1 - bx0, PH = by1 - by0;
const W = Math.round(PW * SCALE), H = Math.round(PH * SCALE), N = W * H;
const baseHue = cfg.baseHue ?? 195;

// ---------- màu ----------
function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  return [h, s, l];
}
// kẹp 0–255: tâm ô màu (×17 + 8) có thể ra 263 → "#107107107", trình duyệt không hiểu và tô ĐEN
const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
function roleOfColor(r, g, b) {
  const [h, s, l] = hsl(r, g, b);
  const dh = Math.abs(((h - baseHue + 540) % 360) - 180);
  if (l > 0.86 && s < 0.25) return "ink";          // trắng/xám rất nhạt
  if (l < 0.2 && s < 0.4) return "ink";            // đen/xám rất đậm
  if (dh < 40 && s > 0.2) return "brand";          // họ màu của hãng gốc
  return "keep";                                   // màu mang nghĩa (đỏ, lục, vàng…)
}

// ---------- 1. vẽ trang, chia từng lệnh vẽ về đúng lớp ----------
const M = mupdf.Matrix.concat(mupdf.Matrix.translate(-bx0, -by0), mupdf.Matrix.scale(SCALE, SCALE));
function newLayer() {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, W, H], true);
  pix.clear();
  return { pix, dev: new mupdf.DrawDevice(mupdf.Matrix.identity, pix) };
}
const L_art = newLayer();       // hình (không chữ) của các layer nội dung
const L_text = newLayer();      // chỉ chữ
const L_full = newLayer();      // hình + chữ (để cắt card: chữ trong card là một phần minh hoạ)
const L_decor = newLayer();     // layer BG trừ hình phủ kín trang
const L_page = newLayer();      // cả trang như bản gốc (ảnh thu nhỏ + đối chiếu)
const L_base = newLayer();      // chỉ dải nền gốc — để đối chiếu với bản Illustrator
const ALL = [L_art, L_text, L_full, L_decor, L_page, L_base];

const layerStack = [];
let maskDepth = 0;
const curLayer = () => layerStack[layerStack.length - 1] || "";
const areaOf = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const pageArea = W * H;          // khung lệnh vẽ tính bằng pixel (đã nhân SCALE)
let skippedBase = 0;

function targets(kind, bounds) {
  if (maskDepth > 0) return ALL;                   // nét vẽ định nghĩa mặt nạ: mọi lớp đều cần
  const lay = curLayer();
  if (hideLayers.has(lay)) return [];
  if (lay === bgLayer) {
    if (bounds && areaOf(bounds) >= pageArea * 0.85) { skippedBase++; return [L_page, L_base]; }   // dải nền gốc
    return [L_decor, L_page];
  }
  if (!hasLayers && kind !== "text" && bounds && areaOf(bounds) >= pageArea * 0.85) { skippedBase++; return [L_page, L_base]; }
  if (kind === "text") return [L_text, L_full, L_page];
  return [L_art, L_full, L_page];
}
const call = (list, m, args) => { let r; for (const t of list) r = t.dev[m](...args); return r; };
const every = (m) => (...a) => call(ALL, m, a);
const router = new mupdf.Device({
  beginLayer(name) { layerStack.push(name); call(ALL, "beginLayer", [name]); },
  endLayer() { layerStack.pop(); call(ALL, "endLayer", []); },
  fillPath(p, eo, ctm, cs, c, a) {
    const t = targets("art", p.getBounds(null, ctm));
    if (t.includes(L_base) && c && c.length === 3) baseColor = hex(...c.map((v) => v * 255));   // màu nền gốc
    call(t, "fillPath", [p, eo, ctm, cs, c, a]);
  },
  strokePath(p, st, ctm, cs, c, a) { call(targets("art", p.getBounds(st, ctm)), "strokePath", [p, st, ctm, cs, c, a]); },
  fillShade(sh, ctm, a) { call(targets("art", sh.getBounds(ctm)), "fillShade", [sh, ctm, a]); },
  fillImage(im, ctm, a) { call(targets("art", null), "fillImage", [im, ctm, a]); },
  fillImageMask(im, ctm, cs, c, a) { call(targets("art", null), "fillImageMask", [im, ctm, cs, c, a]); },
  fillText(t, ctm, cs, c, a) { call(targets("text", null), "fillText", [t, ctm, cs, c, a]); },
  strokeText(t, st, ctm, cs, c, a) { call(targets("text", null), "strokeText", [t, st, ctm, cs, c, a]); },
  ignoreText: every("ignoreText"),
  clipPath: every("clipPath"), clipStrokePath: every("clipStrokePath"),
  clipText: every("clipText"), clipStrokeText: every("clipStrokeText"),
  clipImageMask: every("clipImageMask"), popClip: every("popClip"),
  beginMask(...a) { maskDepth++; call(ALL, "beginMask", a); },
  endMask(...a) { call(ALL, "endMask", a); maskDepth--; },
  beginGroup: every("beginGroup"), endGroup: every("endGroup"),
  beginTile: every("beginTile"), endTile: every("endTile"),
  close() {},
});
page.run(router, M);
ALL.forEach((l) => l.dev.close());

// MuPDF lưu màu đã nhân sẵn với độ trong suốt → chia lại để có màu thật
function unpack(pix) {
  const s = pix.getPixels(), n = pix.getNumberOfComponents(), rgba = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const a = s[i * n + 3];
    rgba[i * 4 + 3] = a;
    if (a) for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.min(255, Math.round((s[i * n + k] * 255) / a));
  }
  return rgba;
}
const art = unpack(L_art.pix), txt = unpack(L_text.pix), full = unpack(L_full.pix);
const decor = unpack(L_decor.pix), pg = unpack(L_page.pix), base = unpack(L_base.pix);

function writePng(file, w, h, fill) {
  const png = new PNG({ width: w, height: h });
  fill(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

// Soát: --dump x,y,w,h (pt) → cắt vùng đó từ từng lớp, đặt lên nền ca rô, xếp dọc
// [hình | chữ | hình+chữ] vào verify/dump.png để người soát nhìn lớp nào chứa gì.
{
  const di = process.argv.indexOf("--dump");
  if (di > 0) {
    const [dx, dy, dw, dh] = process.argv[di + 1].split(",").map((v) => Math.round(Number(v) * SCALE));
    const srcs = [art, txt, full];
    fs.mkdirSync(path.join(outDir, "verify"), { recursive: true });
    writePng(path.join(outDir, "verify", "dump.png"), dw, dh * 3 + 8, (d) => {
      for (let k = 0; k < 3; k++) for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        const o = ((k * (dh + 4) + y) * dw + x) * 4, i = ((dy + y) * W + (dx + x)) * 4, s = srcs[k];
        const chk = ((x >> 3) + (y >> 3)) % 2 ? 170 : 110, a = s[i + 3] / 255;
        d[o] = s[i] * a + chk * (1 - a); d[o + 1] = s[i + 1] * a + chk * (1 - a); d[o + 2] = s[i + 2] * a + chk * (1 - a); d[o + 3] = 255;
      }
    });
    console.log("dump → " + path.join(outDir, "verify", "dump.png"));
  }
}
const toPt = (v) => +(v / SCALE).toFixed(2);
function crop(src, x0, y0, w, h, alphaFn) {
  return (d) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * W + (x0 + x)) * 4, o = (y * w + x) * 4;
      d[o] = src[i]; d[o + 1] = src[i + 1]; d[o + 2] = src[i + 2];
      d[o + 3] = alphaFn ? alphaFn(x0 + x, y0 + y, src[i + 3]) : src[i + 3];
    }
  };
}
function maskPng(x0, y0, w, h, alphaFn) {
  return (d) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = alphaFn(x0 + x, y0 + y);
    }
  };
}

// ---------- 3. tách lớp hình thành khối liền nhau (theo độ trong suốt, không đoán nền) ----------
const comp = new Int32Array(N);
const comps = [null];
{
  const st = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (comp[s] || art[s * 4 + 3] < 10) continue;
    const c = { id: comps.length, x0: W, y0: H, x1: 0, y1: 0, px: [] };
    let sp = 0; st[sp++] = s; comp[s] = c.id;
    while (sp) {
      const p = st[--sp], x = p % W, y = (p / W) | 0;
      c.px.push(p);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (!comp[q] && art[q * 4 + 3] >= 10) { comp[q] = c.id; st[sp++] = q; }
      }
    }
    comps.push(c);
  }
}

const logoSlots = cfg.logoSlots || [];
const inBox = (x, y, b, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
const owner = new Int32Array(N);         // pixel → chỉ số lớp (+1) sở hữu nó, để biết chữ nằm trên cái gì
const layers = [];
const pendingPanels = [];            // panel ghi sau khi biết dòng chữ nào được vẽ lại
let nCard = 0, nShape = 0, nImage = 0, nTiny = 0;

for (const c of comps.slice(1)) {
  const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
  const box = { x: c.x0 / SCALE, y: c.y0 / SCALE, w: bw / SCALE, h: bh / SCALE };
  if (c.px.length < 12) { nTiny++; continue; }
  if (logoSlots.some((z) => !z.add && inBox(box.x + box.w / 2, box.y + box.h / 2, z, 6))) continue;   // logo cũ

  // màu của phần đặc (bỏ viền mờ và bóng đổ nhạt)
  let solid = 0, white = 0; const bins = new Map();
  for (const p of c.px) {
    if (art[p * 4 + 3] < 200) continue;
    solid++;
    const r = art[p * 4], g = art[p * 4 + 1], b = art[p * 4 + 2];
    if (r > 238 && g > 238 && b > 238) white++;
    const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  const common = { x: toPt(c.x0), y: toPt(c.y0), w: toPt(bw), h: toPt(bh) };
  // Chỉ hình NHỎ và ĐƠN GIẢN (nhãn thấp, icon, chấm) mới được tách theo màu để tô lại.
  // Khối lớn là minh hoạ → giữ nguyên ảnh gốc. Trước đây card khay xanh ít màu trắng
  // bị tách thành 4 khuôn màu → mất dây cáp, mặt cười, màu da tay.
  // ≤ 2500pt² để gồm cả icon tiêu đề mục (ống nghe, xe đẩy ~38×38pt) — nếu không chúng
  // thành card, giữ nguyên xanh ngọc gốc, lạc tông khi áp màu hãng
  const graphic = box.h <= 24 || box.w * box.h <= 2500;
  const isCard = !graphic && solid > 0 && white / solid > 0.2;

  if (isCard) {
    // Panel = card rất lớn (tấm trắng bên phải trang 2, chứa tiêu đề và logo). Chữ trên
    // panel là NỘI DUNG, không phải nhãn trong minh hoạ → cắt từ lớp hình không chữ,
    // chữ vẽ lại bằng vector (đổi màu được); ô logo cũ trên panel tô lấp bằng màu panel.
    const panel = box.w * box.h > PW * PH * 0.12;
    const file = `${panel ? "panel" : "card"}-${++nCard}.png`;
    const topBin = [...bins.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0xfff;
    const fillC = [((topBin >> 8) & 15) * 17, ((topBin >> 4) & 15) * 17, (topBin & 15) * 17];
    const inSlot = (x, y) => logoSlots.some((z) => !z.add && inBox(x / SCALE, y / SCALE, z, 2.5));
    // Panel ghi SAU bước chữ: lấy lớp hình+chữ (giữ chữ in dọc trên thân máy D60), chỉ
    // vùng chữ được vẽ lại bằng vector mới lấy lớp không chữ — tránh chữ in hai lần.
    const writeCard = (textBoxes) => writePng(path.join(assetDir, file), bw, bh, (d) => {
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const X = c.x0 + x, Y = c.y0 + y, p = Y * W + X, i = p * 4, o = (y * bw + x) * 4;
        if (comp[p] !== c.id) { d[o + 3] = 0; continue; }
        if (panel && inSlot(X, Y)) { d[o] = fillC[0]; d[o + 1] = fillC[1]; d[o + 2] = fillC[2]; d[o + 3] = art[i + 3]; continue; }
        const src = (!bakeCardText || (panel && textBoxes.some((b) => inBox(X / SCALE, Y / SCALE, b, 1.2)))) ? art : full;
        d[o] = src[i]; d[o + 1] = src[i + 1]; d[o + 2] = src[i + 2]; d[o + 3] = src[i + 3];
      }
    });
    if (panel) pendingPanels.push({ id: file.replace(".png", ""), write: writeCard }); else writeCard([]);
    const idx = layers.push({ kind: panel ? "panel" : "card", id: file.replace(".png", ""), ...common, src: `assets/${file}`,
      ...(panel || !bakeCardText ? { color: hex(...fillC) } : {}) });
    for (const p of c.px) owner[p] = idx;
    continue;
  }

  // gộp màu thành cụm; khối vài cụm → mỗi cụm một shape; nhiều sắc độ → image
  const clusters = [];
  for (const [k, n] of [...bins.entries()].sort((a, b) => b[1] - a[1])) {
    const col = [((k >> 8) & 15) * 17 + 8, ((k >> 4) & 15) * 17 + 8, (k & 15) * 17 + 8];
    const near = clusters.find((q) => Math.abs(q.c[0] - col[0]) + Math.abs(q.c[1] - col[1]) + Math.abs(q.c[2] - col[2]) < 70);
    if (near) near.n += n; else clusters.push({ c: col, n });
  }
  const strong = solid ? clusters.filter((q) => q.n / solid >= 0.04) : [];
  const covered = strong.reduce((s, q) => s + q.n, 0) / (solid || 1);
  // Khối phẳng lớn (ô xanh chữ trắng, bong bóng, thanh điều hướng của bộ slide) cũng tách thành
  // khuôn để tô ĐÚNG màu hãng — xoay tông ảnh chỉ ra gần đúng. Điều kiện: ≤ 3 màu, phủ ≥ 90%,
  // không màu nào là màu mang nghĩa/màu da (nhân vật minh hoạ luôn có → vẫn là ảnh, giữ nguyên).
  const flat = strong.length > 0 && strong.length <= 3 && covered >= 0.9 && strong.every((q) => roleOfColor(...q.c) !== "keep");
  const gradient = !(graphic || flat) || !strong.length || strong.length > 3 || covered < 0.85;

  if (gradient) {
    const file = `image-${++nImage}.png`;
    writePng(path.join(assetDir, file), bw, bh, crop(art, c.x0, c.y0, bw, bh, (x, y, a) => (comp[y * W + x] === c.id ? a : 0)));
    const dom = strong[0] ? hex(...strong[0].c) : null;
    const idx = layers.push({ kind: "image", id: file.replace(".png", ""), ...common, src: `assets/${file}`,
      // khối chuyển màu thuộc họ màu hãng (vd nửa hình sóng nằm ở Layer 1) → xoay tông.
      // Minh hoạ thật có nền trắng nên đã thành card ở trên, không rơi vào đây.
      // chỉ xoay tông khi MỌI màu chính đều thuộc họ hãng hoặc trắng/đen. Nhân vật mặc áo
      // xanh (họ màu hãng) vẫn có màu da → xoay cả hình sẽ đổi luôn màu da → giữ nguyên.
      tint: strong.length > 0 && strong.some((q) => roleOfColor(...q.c) === "brand")
        && strong.every((q) => ["brand", "ink"].includes(roleOfColor(...q.c))), dominant: dom });
    for (const p of c.px) owner[p] = idx;
    continue;
  }

  // Mỗi pixel về cụm màu gần nhất. Cụm "nền của khối" (nhiều pixel nhất) lấy nguyên
  // hình khối làm khuôn — các cụm còn lại vẽ đè lên, nên không có khe hở giữa các màu.
  strong.sort((a, b) => b.n - a.n);
  const assign = new Map();
  for (const p of c.px) {
    const r = art[p * 4], g = art[p * 4 + 1], b = art[p * 4 + 2];
    let bi = 0, bd = 1e9;
    strong.forEach((q, i) => { const d = Math.abs(q.c[0] - r) + Math.abs(q.c[1] - g) + Math.abs(q.c[2] - b); if (d < bd) { bd = d; bi = i; } });
    assign.set(p, bi);
  }
  const baseId = `shape-${nShape + 1}`;
  strong.forEach((q, i) => {
    const file = `shape-${++nShape}.png`;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (const p of c.px) if (i === 0 || assign.get(p) === i) {
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    writePng(path.join(assetDir, file), w, h, maskPng(x0, y0, w, h, (x, y) => {
      const p = y * W + x;
      if (comp[p] !== c.id) return 0;
      return i === 0 || assign.get(p) === i ? art[p * 4 + 3] : 0;
    }));
    const color = hex(...q.c);
    const idx = layers.push({ kind: "shape", id: file.replace(".png", ""), x: toPt(x0), y: toPt(y0), w: toPt(w), h: toPt(h),
      mask: `assets/${file}`, role: roleOfColor(...q.c), color, ...(i > 0 ? { on: baseId } : {}) });
    for (const p of c.px) if (i === 0 || assign.get(p) === i) owner[p] = idx;   // cụm nền nhận hết, cụm sau đè lên
  });
}

// khối nằm trên nền hay trên khối khác (dò viền ngoài khung)
for (const L of layers) {
  if (L.on) continue;
  const count = new Map();
  const x0 = Math.max(0, Math.floor(L.x * SCALE) - 3), x1 = Math.min(W - 1, Math.ceil((L.x + L.w) * SCALE) + 3);
  const y0 = Math.max(0, Math.floor(L.y * SCALE) - 3), y1 = Math.min(H - 1, Math.ceil((L.y + L.h) * SCALE) + 3);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x - x0 > 2 && x1 - x > 2 && y - y0 > 2 && y1 - y > 2) continue;
    const o = owner[y * W + x], key = o ? layers[o - 1].id : "bg";
    if (key === L.id) continue;
    count.set(key, (count.get(key) || 0) + 1);
  }
  L.on = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "bg";
}

// Nhóm đồng bộ: mọi nhãn tiêu đề mục phải cùng một kiểu. File gốc có hai biến thể
// (mục 1 xanh đậm, mục 3 xanh ngọc) → tính màu riêng từng cái thì chữ nhãn này đen,
// nhãn kia trắng, ô tròn số nhãn này trắng, nhãn kia tối. Gắn nhóm để bộ vẽ tính MỘT LẦN.
//   badge     = viên thuốc màu hãng, cao 15–24pt, dài ≥ 40pt
//   badge-dot = hình trắng/đen nằm trên viên thuốc (ô tròn chứa số đề mục)
for (const L of layers) {
  if (L.kind === "shape" && L.role === "brand" && L.h >= 15 && L.h <= 24 && L.w >= 40 && L.on === "bg") L.group = "badge";
}
for (const L of layers) {
  const p = layers.find((q) => q.id === L.on);
  if (L.kind === "shape" && L.role === "ink" && p && p.group === "badge") L.group = "badge-dot";
}

// Logo hình mờ: hình lớn trong thiết kế thực chất là logo của hãng gốc (D60 trang 1:
// hình sóng chữ "V" của UVsmart). Khai trong cấu hình "watermarks"; khi người dùng có
// logo, bộ vẽ ẩn lớp này và đặt logo của họ vào đúng khung đó.
const watermarks = cfg.watermarks || [];
for (const L of layers) {
  const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
  if (L.kind !== "card" && L.kind !== "panel" && watermarks.some((z) => inBox(cx, cy, z, 2))) L.watermark = true;
}

// decor: phần còn lại của layer nền (sóng, vệt sáng), một ảnh trong suốt
{
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let i = 0; i < N; i++) if (decor[i * 4 + 3] > 4) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 >= 0) {
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    writePng(path.join(assetDir, "decor.png"), w, h, crop(decor, x0, y0, w, h));
    // thêm vào CUỐI: chèn đầu mảng sẽ làm lệch chỉ số trong bản đồ owner (chữ nhãn 3.1 từng bị ghi là nằm trên ô tròn nhãn 1.1)
    layers.push({ kind: "decor", id: "decor", x: toPt(x0), y: toPt(y0), w: toPt(w), h: toPt(h), src: "assets/decor.png", tint: true, on: "bg" });
  }
}

// ---------- 4. chữ dạng VECTOR: đúng hình chữ font gốc, nét ở mọi cỡ ----------
// Khuôn chữ ảnh ×4 bị trình duyệt thu nhỏ thô → chữ mảnh, lởm chởm trên màn hình.
// Nên chạy thêm một lượt chỉ vẽ chữ sang bộ xuất SVG của MuPDF: mỗi chữ cái ra một
// <use data-text="V" href="#font_x_y" transform="cỡ,0,0,-cỡ, gốcX, gốcY" fill="màu">,
// hình chữ là vector của font gốc.
// Dòng chữ dựng THẲNG từ các chữ cái này (không dùng bảng chữ của MuPDF: bảng đó bỏ
// sót cả dòng — "Vorbereitung" của nhãn 1.1 có trong bản vẽ mà không có trong bảng).
const glyphDefs = {}, uses = [];
{
  const buf = new mupdf.Buffer();
  const w = new mupdf.DocumentWriter(buf, "svg", "text=path");
  const sdev = w.beginPage(page.getBounds());
  let inMask = 0;
  const pass = (m) => (...a) => sdev[m](...a);
  const onlyMask = (m) => (...a) => { if (inMask) sdev[m](...a); };
  page.run(new mupdf.Device({
    fillText: pass("fillText"), strokeText: pass("strokeText"),
    clipPath: pass("clipPath"), clipStrokePath: pass("clipStrokePath"), clipText: pass("clipText"),
    clipStrokeText: pass("clipStrokeText"), clipImageMask: pass("clipImageMask"), popClip: pass("popClip"),
    beginMask(...a) { inMask++; sdev.beginMask(...a); }, endMask(...a) { sdev.endMask(...a); inMask--; },
    fillPath: onlyMask("fillPath"), strokePath: onlyMask("strokePath"), fillShade: onlyMask("fillShade"),
    fillImage: onlyMask("fillImage"), fillImageMask: onlyMask("fillImageMask"),
    beginGroup: pass("beginGroup"), endGroup: pass("endGroup"), beginTile: pass("beginTile"), endTile: pass("endTile"),
    beginLayer() {}, endLayer() {}, ignoreText() {}, close() {},
  }), mupdf.Matrix.identity);
  sdev.close(); w.endPage(); w.close();
  const svg = Buffer.from(buf.asUint8Array()).toString("utf8");
  for (const m of svg.matchAll(/<path id="(font_\w+)" d="([^"]*)"/g)) glyphDefs[m[1]] = m[2];
  for (const m of svg.matchAll(/<use data-text="([^"]*)" xlink:href="#(font_\w+)" transform="matrix\(([^)]*)\)"(?: fill="(#[0-9a-fA-F]{3,6})")?/g)) {
    const t = m[3].split(",").map(Number);
    const ch = m[1].replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    uses.push({ ch, g: m[2], t: [t[0], t[1], t[2], t[3], t[4] - bx0, t[5] - by0], size: Math.hypot(t[0], t[1]), fill: (m[4] || "#000000").toLowerCase() });
  }
}

// Chữ cái có thực sự hiện ra không. Hai kiểu bị ẩn trong file gốc:
//  - nằm DƯỚI một hình khác (đã gặp: "Sca", "D45" nằm dưới card, Illustrator không hiện)
//  - bị vùng cắt (clip) che
// Cách dò: chỗ chữ hiện ra thì lớp "hình + chữ" khác lớp "chỉ hình". Không khác chỗ nào → bỏ.
function visible(u) {
  const s = u.size;
  const x0 = Math.max(0, Math.floor(u.t[4] * SCALE)), x1 = Math.min(W - 1, Math.ceil((u.t[4] + s * 0.6) * SCALE));
  const y0 = Math.max(0, Math.floor((u.t[5] - s * 0.72) * SCALE)), y1 = Math.min(H - 1, Math.ceil(u.t[5] * SCALE));
  let hit = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    if (txt[i + 3] < 100) continue;
    const d = Math.abs(full[i] - art[i]) + Math.abs(full[i + 1] - art[i + 1]) + Math.abs(full[i + 2] - art[i + 2]) + Math.abs(full[i + 3] - art[i + 3]);
    if (d > 60 && ++hit >= 3) return true;
  }
  return false;
}

// gom chữ cái thành dòng: cùng cỡ, cùng đường chân chữ, liền nhau theo chiều ngang
const vlines = [];
let hiddenGlyphs = 0;
// xếp theo đường chân chữ đã làm tròn 0,5pt rồi mới theo chiều ngang: xếp theo số lẻ
// chính xác thì "2" (y=81,0001) đứng sau cả dòng "3." (y=81,0000) → dòng bị chẻ vụn
const yKey = (u) => Math.round(u.t[5] * 2);
for (const u of uses.slice().sort((a, b) => yKey(a) - yKey(b) || a.t[4] - b.t[4])) {
  if (u.size < 3) continue;                               // chữ tí hon trong màn hình thiết bị = minh hoạ
  // Chữ xoay (in dọc trên thân máy trong minh hoạ) — đã có sẵn trong ảnh card; vẽ lại
  // thì phép dò "có hiện không" tính khung theo chữ ngang nên sai → lộ thành chấm lạ.
  if (Math.abs(u.t[1]) > 0.01 || Math.abs(u.t[2]) > 0.01) { hiddenGlyphs++; continue; }
  // so với gốc của chữ cái TRƯỚC, không so với bề rộng ước lượng: ước 0,6×cỡ là quá rộng
  // với chữ hẹp như "i" → chữ "n" ngay sau bị coi là lùi lại và văng sang dòng khác
  const line = vlines.find((L) => Math.abs(L.y - u.t[5]) < u.size * 0.08 && Math.abs(L.size - u.size) < 0.05
    && u.t[4] >= L.lastX - 0.01 && u.t[4] - L.lastX < u.size * 2.2);
  const item = { ...u, vis: u.ch === " " ? true : visible(u) };
  if (u.ch !== " " && !item.vis) hiddenGlyphs++;
  if (line) { line.items.push(item); line.lastX = u.t[4]; }
  else vlines.push({ y: u.t[5], size: u.size, lastX: u.t[4], items: [item] });
}

const usedGlyphs = new Set();
const textLines = vlines.map((L) => {
  const items = L.items.filter((i) => i.vis).sort((a, b) => a.t[4] - b.t[4]);
  while (items.length && items[items.length - 1].ch === " ") items.pop();
  while (items.length && items[0].ch === " ") items.shift();
  if (!items.length) return null;
  const s = L.size, x0 = items[0].t[4], x1 = items[items.length - 1].t[4] + s * 0.6;
  const box = { x: x0, y: L.y - s * 0.78, w: x1 - x0, h: s * 0.98 };
  const spans = [];
  for (const i of items) {
    const prev = spans[spans.length - 1];
    if (prev && (prev.color === i.fill || i.ch === " ")) { prev.items.push(i); continue; }
    const [r, g, b] = [1, 3, 5].map((k) => parseInt((i.fill.length === 4 ? i.fill.replace(/(\w)/g, "$1$1") : i.fill).slice(k, k + 2), 16));
    spans.push({ color: i.fill, role: roleOfColor(r, g, b), items: [i] });
  }
  return { box, spans };
}).filter(Boolean);

// ---------- 5. mỗi dòng / mỗi đoạn chữ nằm trên cái gì ----------
// Tính RIÊNG cho từng đoạn: nhãn "1.1 Vorbereitung" có số "1.1" xanh đậm nằm trên ô
// tròn trắng, còn chữ trắng nằm trên viên thuốc xanh — chung một dòng nhưng khác nền.
function underOf(box) {
  const count = new Map();
  const X0 = Math.floor(box.x * SCALE), X1 = Math.ceil((box.x + box.w) * SCALE);
  const Y0 = Math.floor(box.y * SCALE), Y1 = Math.ceil((box.y + box.h) * SCALE);
  for (let y = Math.max(0, Y0); y <= Math.min(H - 1, Y1); y++) for (let x = Math.max(0, X0); x <= Math.min(W - 1, X1); x++) {
    const o = owner[y * W + x], key = o && art[(y * W + x) * 4 + 3] > 128 ? layers[o - 1].id : "bg";
    count.set(key, (count.get(key) || 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "bg";
}
const text = [];
let dropped = 0;
for (const z of logoSlots) z.on = underOf(z);             // ô logo nằm trên gì (nền, hay panel trắng)
for (const t of textLines) {
  const cx = t.box.x + t.box.w / 2, cy = t.box.y + t.box.h / 2;
  if (logoSlots.some((z) => !z.add && inBox(cx, cy, z, 3))) continue;  // chữ của logo cũ (vd "uvsmart") — tool vẽ logo mới
  // Chữ xoay dọc (vd chữ in trên thân máy D60 trong minh hoạ): khung tính theo chữ nằm
  // ngang bị lệch ra ngoài card → tưởng nằm trên nền, vẽ thêm lần nữa thành chấm lạ.
  // Xét cả điểm gốc của chữ cái đầu: nằm trong card thì đã có sẵn trong ảnh card.
  const g0 = t.spans[0].items.find((i) => i.ch !== " ");
  if (g0) {
    const ox = Math.min(W - 1, Math.max(0, Math.round(g0.t[4] * SCALE))), oy = Math.min(H - 1, Math.max(0, Math.round(g0.t[5] * SCALE)));
    const ow = owner[oy * W + ox];
    if (bakeCardText && ow && layers[ow - 1].kind === "card") { dropped++; continue; }
  }
  const on = underOf(t.box);
  if (bakeCardText && on.startsWith("card-")) { dropped++; continue; }         // đã nằm sẵn trong ảnh card

  const spans = t.spans.map((s) => {
    const vis = s.items.filter((i) => i.ch !== " ");
    const sx0 = Math.min(...vis.map((i) => i.t[4])), sx1 = Math.max(...vis.map((i) => i.t[4] + i.size * 0.55));
    return {
      text: s.items.map((i) => i.ch).join(""), color: s.color, role: s.role,
      on: vis.length ? underOf({ x: sx0, y: t.box.y, w: sx1 - sx0, h: t.box.h }) : on,
      glyphs: vis.map((i) => { usedGlyphs.add(i.g); return [i.g, ...i.t.map((v) => +v.toFixed(3))]; }),
    };
  });
  text.push({ on, box: { x: +t.box.x.toFixed(2), y: +t.box.y.toFixed(2), w: +t.box.w.toFixed(2), h: +t.box.h.toFixed(2) }, spans });
}
const nMissing = 0;
for (const pp of pendingPanels) {
  pp.write(text.filter((t) => t.on === pp.id || t.spans.some((s) => s.on === pp.id)).map((t) => t.box));
}

// thu nhỏ bằng cách lấy trung bình từng ô
function shrink(src, file, TW) {
  const f = W / TW, TH = Math.round(H / f);
  writePng(file, TW, TH, (d) => {
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y * f); yy < Math.floor((y + 1) * f); yy++)
        for (let xx = Math.floor(x * f); xx < Math.floor((x + 1) * f); xx++) {
          const i = (yy * W + xx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      const i = (y * TW + x) * 4;
      d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; d[i + 3] = a / n;
    }
  });
}
shrink(pg, path.join(outDir, "thumb.png"), 320);
// Bản đối chiếu (×2): cả trang gốc và riêng dải nền gốc. Chỉ dùng để soát độ
// chính xác so với Illustrator, không đưa lên git (xem .gitignore).
fs.mkdirSync(path.join(outDir, "verify"), { recursive: true });
shrink(pg, path.join(outDir, "verify", "page.png"), Math.round(PW * 2));
shrink(base, path.join(outDir, "verify", "base.png"), Math.round(PW * 2));

const tpl = {
  version: 2, id: cfg.id, name: cfg.name, width: +PW.toFixed(2), height: +PH.toFixed(2),
  baseHue, defaultColor: cfg.defaultColor, defaultName: cfg.defaultName, logoSlots, watermarks,
  // "keep" = giữ nền gốc (bộ slide Canva nền kem); "brand" = dải nền sinh từ màu hãng (D60)
  background: { mode: cfg.background || "brand", color: baseColor },
  glyphs: Object.fromEntries([...usedGlyphs].sort().map((g) => [g, glyphDefs[g]])),
  layers, text,
};
fs.writeFileSync(path.join(outDir, "template.json"), JSON.stringify(tpl, null, 1));

if (!noRegister) {
  const regPath = path.join("public", "templates", "index.json");
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, "utf8")) : [];
  const entry = { id: cfg.id, name: cfg.name };
  const at = reg.findIndex((r) => r.id === cfg.id);
  if (at >= 0) reg[at] = entry; else reg.push(entry);
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");
}

console.log(`${cfg.id}: ${PW.toFixed(0)}×${PH.toFixed(0)} pt, vẽ ×${SCALE} (${W}×${H}px) · bỏ ${skippedBase} hình nền phủ kín`);
console.log(`  card ${nCard} · shape ${nShape} · image ${nImage} · decor ${layers.some((l) => l.kind === "decor") ? 1 : 0} · vụn bỏ ${nTiny}`);
console.log(`  chữ: ${text.length} dòng (${text.reduce((s, t) => s + t.spans.length, 0)} đoạn; trên nền ${text.filter((t) => t.on === "bg").length}, trên khối ${text.filter((t) => t.on !== "bg").length}) · nằm trong card ${dropped}`);
console.log(`  chữ vector: ${usedGlyphs.size} hình chữ gốc · bỏ ${hiddenGlyphs} chữ cái bị che · ghép hụt: ${nMissing}`);
console.log(`  → ${outDir}`);
// thoát thẳng: bộ dọn bộ nhớ của mupdf (wasm) đôi khi lỗi lúc đóng tài liệu, sau khi mọi file đã ghi xong
process.exit(0);
