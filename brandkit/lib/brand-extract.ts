// Phân tích một website để lấy nhận diện thương hiệu: tên, logo, màu chủ đạo.
// Không dùng AI — chỉ đọc HTML/CSS/manifest nên không tốn chi phí gọi model.
//
// An toàn: server đi lấy link do người dùng dán vào, nên phải chặn mọi địa chỉ
// nội bộ. Trên Cloud Run, 169.254.169.254 (metadata server) trả ra token của
// chính service account — để lọt là mất quyền truy cập cả dự án.

import dns from "node:dns/promises";
import net from "node:net";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata"]);

function ipIsPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)   // CGNAT
      || (a === 169 && b === 254)             // link-local + metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;                             // multicast + dự trữ
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80")) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? ipIsPrivate(mapped[1]) : false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("That doesn't look like a valid link"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http/https links are supported");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Internal addresses are not allowed");
  }
  let addrs: { address: string }[];
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); }
  catch { throw new Error(`Couldn't find a website at ${host}`); }
  if (!addrs.length || addrs.some((a) => ipIsPrivate(a.address))) {
    throw new Error("Internal addresses are not allowed");
  }
  return u;
}

type Fetched = { url: string; type: string; body: Buffer };

// fetch có giới hạn: tự đi theo redirect nhưng kiểm tra lại từng chặng,
// cắt ngang khi quá dung lượng hoặc quá giờ.
export async function safeFetch(raw: string, opts: { maxBytes: number; timeoutMs: number; accept?: string }): Promise<Fetched> {
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertPublicUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      // Bộ header giống Chrome thật: nhiều trang lớn (vd vinamilk.com.vn) trả 403
      // cho request từ Cloud Run nếu thiếu các header điều hướng này.
      const isPage = (opts.accept || "").includes("text/html");
      const r = await fetch(u, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": UA,
          Accept: isPage ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8" : (opts.accept || "*/*"),
          "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
          "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": isPage ? "document" : "image",
          "Sec-Fetch-Mode": isPage ? "navigate" : "no-cors",
          "Sec-Fetch-Site": isPage ? "none" : "cross-site",
          ...(isPage ? { "Sec-Fetch-User": "?1", "Upgrade-Insecure-Requests": "1" } : {}),
        },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
        current = new URL(r.headers.get("location")!, u).toString();
        continue;
      }
      if (!r.ok) {
        const err: any = new Error(`The site responded with ${r.status}`);
        err.status = r.status;
        throw err;
      }
      const declared = Number(r.headers.get("content-length") || 0);
      if (declared > opts.maxBytes) throw new Error("File too large");

      const chunks: Buffer[] = [];
      let size = 0;
      const reader = r.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > opts.maxBytes) { ctrl.abort(); break; }   // đủ dùng, không đọc thêm
          chunks.push(Buffer.from(value));
        }
      }
      return { url: u.toString(), type: (r.headers.get("content-type") || "").toLowerCase(), body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

// ---------- đọc HTML ----------

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : "";
}
function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function abs(href: string, base: string): string {
  try { return new URL(decode(href), base).toString(); } catch { return ""; }
}
function metaContent(html: string, key: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const t of tags) {
    const k = (attr(t, "name") || attr(t, "property")).toLowerCase();
    if (k === key) return decode(attr(t, "content"));
  }
  return "";
}

// ---------- màu ----------

type RGB = [number, number, number];

function parseColor(v: string): RGB | null {
  v = v.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return [+m[1], +m[2], +m[3]].map((n) => Math.min(255, n)) as RGB;
  return null;
}
function toHex(c: RGB): string {
  return "#" + c.map((n) => n.toString(16).padStart(2, "0")).join("");
}
function hsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s, l];
}
// Màu mặc định framework tự nhét vào trang, không phải màu hãng. Đo thật:
// vietcombank.com.vn ra #0d6efd (Bootstrap), flearningstudio.com ra #ff6900
// (bảng màu WordPress) — đều đứng đầu nếu không loại.
const FRAMEWORK_DEFAULTS = new Set([
  // Bootstrap 4/5
  "#0d6efd", "#6610f2", "#6f42c1", "#d63384", "#dc3545", "#fd7e14", "#ffc107", "#198754",
  "#20c997", "#0dcaf0", "#007bff", "#28a745", "#17a2b8", "#343a40", "#6c757d",
  // WordPress core palette + thông báo quản trị
  "#f78da7", "#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#00d084", "#8ed1fc", "#0693e3",
  "#9b51e0", "#abb8c3", "#dc3232", "#46b450", "#ffb900", "#00a0d2", "#cc3366",
]);

// Màu "mang tính thương hiệu" = có sắc độ rõ, không gần trắng/đen/xám.
function isBrandish(c: RGB): boolean {
  const [, s, l] = hsl(c);
  return s >= 0.22 && l >= 0.12 && l <= 0.88;
}

export type ColorCandidate = { hex: string; score: number; source: string };

function collectColors(html: string, css: string[], manifest: any): ColorCandidate[] {
  const bag = new Map<string, ColorCandidate>();
  function add(v: string, score: number, source: string, explicit = false) {
    const c = parseColor(v);
    if (!c || !isBrandish(c)) return;
    const hex = toHex(c);
    if (!explicit && FRAMEWORK_DEFAULTS.has(hex)) return;
    const prev = bag.get(hex);
    if (!prev) bag.set(hex, { hex, score, source });
    else { prev.score += score * 0.5; if (score > 40 && prev.score < score) prev.source = source; }
  }

  // các thẻ do chính chủ trang khai báo thì tin, kể cả khi trùng màu framework
  add(metaContent(html, "theme-color"), 90, "thẻ theme-color của trang", true);
  add(metaContent(html, "msapplication-tilecolor"), 70, "màu ô Windows của trang", true);
  if (manifest?.theme_color) add(String(manifest.theme_color), 75, "manifest (theme_color)", true);
  if (manifest?.background_color) add(String(manifest.background_color), 35, "manifest (background_color)");

  const allCss = css.join("\n");
  // biến CSS có tên kiểu --primary, --brand… là tín hiệu mạnh nhất
  // (không nhận "highlight": Vinamilk có --highlight-bg-color là màu tô chữ chọn, không phải màu hãng)
  const varRe = /--([a-z0-9-]*(?:primary|brand|accent|main|theme)[a-z0-9-]*)\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/gi;
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(allCss))) add(m[2], 80, `biến CSS --${m[1]}`);

  // tần suất xuất hiện trong CSS: màu dùng nhiều là màu chủ đạo
  const freq = new Map<string, number>();
  const colRe = /(#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\(\s*\d+[\s,]+\d+[\s,]+\d+[^)]*\))/gi;
  while ((m = colRe.exec(allCss))) {
    const c = parseColor(m[1]);
    if (!c || !isBrandish(c)) continue;
    const hex = toHex(c);
    freq.set(hex, (freq.get(hex) || 0) + 1);
  }
  // Nhân thêm theo độ rực: màu chữ xanh-đen (như #32325d của Stripe) xuất hiện
  // khắp nơi nhưng không phải màu hãng; màu rực mới là màu nhận diện.
  const maxF = Math.max(1, ...freq.values());
  for (const [hex, n] of freq) {
    if (n < 2) continue;
    const [, s, l] = hsl(parseColor(hex)!);
    const vivid = s * (1 - Math.abs(l - 0.5) * 1.4);
    add(hex, (15 + 45 * (n / maxF)) * (0.35 + vivid), `dùng ${n} lần trong CSS`);
  }

  return [...bag.values()].sort((a, b) => b.score - a.score).slice(0, 10);
}

// ---------- logo ----------

type LogoCandidate = { url?: string; inlineSvg?: string; score: number; source: string; mono?: boolean };

// Huy hiệu pháp lý gắn ở chân trang — có chữ "logo" trong tên nhưng không phải logo hãng.
// Đo thật: vinamilk.com.vn bị lấy nhầm huy hiệu Bộ Công Thương (logo_CCDV, màu đỏ).
const NOT_A_LOGO = /bocongthuong|online\.gov\.vn|ccdv|dathongbao|da-thong-bao|salenoti|dmca|protected|certif|badge|payment|visa|mastercard|appstore|google-?play/i;

// Tra màu thật của một biểu thức CSS: #hex, rgb(), hoặc var(--x) (đi tối đa 3 tầng).
function resolveCssColor(expr: string, css: string, depth = 0): string {
  expr = expr.trim().replace(/\s*!important$/, "");
  if (parseColor(expr)) return expr;
  const v = expr.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/);
  if (!v || depth > 3) return "";
  const def = css.match(new RegExp(v[1].replace(/[-]/g, "\\-") + "\\s*:\\s*([^;}]+)"));
  if (def) return resolveCssColor(def[1], css, depth + 1);
  return v[2] ? resolveCssColor(v[2], css, depth + 1) : "";
}

// SVG dùng currentColor thì khi tách ra đứng riêng sẽ thành màu đen. Tra màu từ
// class của nó (vd Vinamilk: class="text-vnm-primary") rồi thay vào.
function paintCurrentColor(svg: string, classes: string, css: string): { svg: string; color: string } {
  if (!/currentcolor/i.test(svg) && /fill\s*=/.test(svg)) return { svg, color: "" };
  let color = "";
  for (const cls of classes.split(/\s+/).filter(Boolean)) {
    const safe = cls.replace(/[^\w-]/g, "\\$&");
    const rule = css.match(new RegExp("\\." + safe + "\\s*\\{[^}]*?(?:^|[;{\\s])color\\s*:\\s*([^;}]+)"));
    if (rule) { color = resolveCssColor(rule[1], css); if (color) break; }
  }
  if (!color) return { svg, color: "" };
  let out = svg.replace(/currentcolor/gi, color);
  if (!/fill\s*=/.test(out.slice(0, out.indexOf(">")))) out = out.replace(/<svg\b/i, `<svg fill="${color}"`);
  return { svg: out, color };
}

function collectLogos(html: string, base: string, manifest: any, manifestUrl: string, css: string): { list: LogoCandidate[]; colors: ColorCandidate[] } {
  const out: LogoCandidate[] = [];
  const logoColors: ColorCandidate[] = [];
  const hint = /logo|brand/i;
  const footerAt = html.search(/<footer\b/i);
  const inFooter = (pos: number) => footerAt >= 0 && pos > footerAt;
  const host = (() => { try { return new URL(base).hostname.replace(/^www\./, ""); } catch { return ""; } })();

  function pushSvg(svgRaw: string, score: number, source: string) {
    if (svgRaw.length > 120000) return;
    const cls = (svgRaw.match(/^<svg\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i) || ["", ""])[1];
    const painted = paintCurrentColor(svgRaw, cls, css);
    if (painted.color) {
      const c = parseColor(painted.color);
      if (c && isBrandish(c)) logoColors.push({ hex: toHex(c), score: 110, source: "màu logo (từ CSS của trang)" });
    }
    // SVG tô bằng currentColor mà không tra ra màu (vd Vinamilk: màu nằm trong CSS
    // tải sau bằng JS). Logo kiểu này vốn được vẽ để đổi màu theo nền — header của
    // chính Vinamilk dùng bản trắng. Nên vẫn giữ làm logo, đánh dấu "mono" để phía
    // trình duyệt tô bằng màu tương phản với nền; màu hãng thì lấy từ icon khác.
    const mono = !painted.color && /currentcolor/i.test(svgRaw);
    out.push({ inlineSvg: painted.svg, score, source, mono });
  }

  // 0. Logo nằm trong link về trang chủ — dấu hiệu mạnh nhất, trang nào cũng làm vậy
  const homeRe = new RegExp(
    `<a\\b[^>]*href\\s*=\\s*["'](?:\\/|\\.\\/|https?:\\/\\/(?:www\\.)?${host.replace(/\./g, "\\.")}\\/?)["'][^>]*>([\\s\\S]{0,60000}?)<\\/a>`, "gi");
  let m: RegExpExecArray | null;
  let homeFound = 0;
  while ((m = homeRe.exec(html)) && homeFound < 3) {
    if (inFooter(m.index)) continue;
    const inner = m[1];
    const svg = inner.match(/<svg\b[\s\S]*?<\/svg>/i);
    const img = inner.match(/<img\b[^>]*>/i);
    if (svg) { pushSvg(svg[0], 140 - homeFound * 5, "logo trong link về trang chủ"); homeFound++; }
    else if (img) {
      const src = attr(img[0], "src") || attr(img[0], "data-src") || (attr(img[0], "srcset").split(/\s+/)[0] || "");
      if (src && !NOT_A_LOGO.test(src + " " + attr(img[0], "alt"))) {
        out.push({ url: abs(src, base), score: 138 - homeFound * 5, source: "logo trong link về trang chủ" });
        homeFound++;
      }
    }
  }

  // 1. <img> có dấu hiệu logo, ưu tiên cái nằm trong <header>, trừ điểm cái ở chân trang
  const header = (html.match(/<header\b[\s\S]*?<\/header>/i) || [""])[0];
  const imgRe = /<img\b[^>]*>/gi;
  while ((m = imgRe.exec(html))) {
    const t = m[0];
    const src = attr(t, "src") || attr(t, "data-src") || (attr(t, "srcset").split(/\s+/)[0] || "");
    if (!src || src.startsWith("data:image/gif")) continue;
    const meta = [attr(t, "class"), attr(t, "id"), attr(t, "alt"), src].join(" ");
    if (!hint.test(meta) || NOT_A_LOGO.test(meta)) continue;
    const inHeader = header.includes(t);
    const isSvg = /\.svg(\?|$)/i.test(src);
    const score = 100 + (inHeader ? 20 : 0) + (isSvg ? 10 : 0) - (inFooter(m.index) ? 60 : 0);
    out.push({ url: abs(src, base), score, source: inHeader ? "ảnh logo trên thanh đầu trang" : "ảnh có tên logo" });
  }

  // 2. <svg> nhúng thẳng, nằm trong phần tử có tên logo
  const svgRe = /<(a|div|span)\b[^>]*(?:class|id|aria-label)\s*=\s*["'][^"']*(?:logo|brand)[^"']*["'][^>]*>\s*(<svg\b[\s\S]*?<\/svg>)/gi;
  while ((m = svgRe.exec(html))) {
    pushSvg(m[2], 105 - (inFooter(m.index) ? 60 : 0), "logo SVG nhúng trong trang");
  }

  // 3. icon khai báo trong <head>
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (const t of links) {
    const rel = attr(t, "rel").toLowerCase();
    const href = attr(t, "href");
    if (!href) continue;
    const size = parseInt((attr(t, "sizes").match(/(\d+)/) || ["0", "0"])[1], 10);
    if (rel.includes("apple-touch-icon")) out.push({ url: abs(href, base), score: 60 + Math.min(size, 256) / 20, source: "icon Apple của trang" });
    else if (rel.split(/\s+/).includes("icon")) {
      const isSvg = /svg/i.test(attr(t, "type")) || /\.svg(\?|$)/i.test(href);
      out.push({ url: abs(href, base), score: 45 + (isSvg ? 15 : 0) + Math.min(size, 256) / 20, source: "favicon" });
    }
  }

  // 4. icon trong manifest
  if (Array.isArray(manifest?.icons)) {
    for (const ic of manifest.icons) {
      if (!ic?.src) continue;
      const size = parseInt(String(ic.sizes || "0").match(/(\d+)/)?.[1] || "0", 10);
      out.push({ url: abs(ic.src, manifestUrl || base), score: 55 + Math.min(size, 512) / 40, source: "icon trong manifest" });
    }
  }

  // 5. ảnh chia sẻ — thường là banner nên để cuối
  const og = metaContent(html, "og:image");
  if (og) out.push({ url: abs(og, base), score: 15, source: "ảnh chia sẻ mạng xã hội (og:image)" });

  out.push({ url: abs("/favicon.ico", base), score: 8, source: "favicon mặc định" });

  const seen = new Set<string>();
  const list = out
    .filter((c) => {
      const key = c.url || c.inlineSvg!.slice(0, 200);
      if (!key || seen.has(key)) return false;
      if (c.url && NOT_A_LOGO.test(c.url)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score);
  return { list, colors: logoColors };
}

function cleanName(html: string): string {
  const site = metaContent(html, "og:site_name") || metaContent(html, "application-name");
  if (site) return site.trim();
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ["", ""])[1]).replace(/\s+/g, " ").trim();
  // "Trang chủ | Tên hãng" / "Tên hãng – Khẩu hiệu": lấy đoạn ngắn nhất, thường là tên
  const parts = title.split(/\s[|–—\-·:]\s/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts.sort((a, b) => a.length - b.length)[0];
  return title;
}

// ---------- ghép lại ----------

export type BrandResult = {
  url: string;
  name: string;
  // mono = logo một màu (currentColor), phía trình duyệt tự tô cho tương phản với nền
  logo: { dataUrl: string; source: string; url?: string; mono?: boolean } | null;
  // ảnh phụ để đọc màu hãng khi logo là loại một màu
  colorImage: { dataUrl: string; source: string } | null;
  colors: ColorCandidate[];
  notes: string[];
};

// Tên từ tên miền: vinamilk.com.vn → "Vinamilk", www.tiki.vn → "Tiki".
function nameFromHost(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  // bỏ đuôi 2 tầng kiểu .com.vn, .co.uk
  const label = parts.length > 2 && parts[parts.length - 2].length <= 3 ? parts[parts.length - 3] : parts[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Dự phòng khi trang chặn máy chủ: lấy icon của trang qua dịch vụ favicon của
// Google (chỉ gửi tên miền, không gửi gì khác). Màu hãng sẽ đọc từ icon này ở
// phía trình duyệt.
async function fallbackFromFavicon(input: string): Promise<BrandResult | null> {
  let host: string;
  try { host = new URL(input).hostname; } catch { return null; }
  const dataUrl = await fetchImage(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`);
  if (!dataUrl) return null;
  return {
    url: input,
    name: nameFromHost(host),
    logo: { dataUrl, source: "site icon (the site blocked direct access)" },
    colorImage: null,
    colors: [],
    notes: ["site blocked direct access — used its icon via Google"],
  };
}

async function fetchImage(url: string): Promise<string | null> {
  try {
    const f = await safeFetch(url, { maxBytes: 1_500_000, timeoutMs: 6000, accept: "image/*" });
    let type = f.type.split(";")[0];
    if (!type.startsWith("image/")) {
      if (/\.svg(\?|$)/i.test(url)) type = "image/svg+xml";
      else if (/\.png(\?|$)/i.test(url)) type = "image/png";
      else if (/\.ico(\?|$)/i.test(url)) type = "image/x-icon";
      else return null;
    }
    if (f.body.length < 100) return null;
    return `data:${type};base64,${f.body.toString("base64")}`;
  } catch { return null; }
}

export async function extractBrand(rawUrl: string): Promise<BrandResult> {
  const trimmed = rawUrl.trim();
  // có scheme mà không phải http/https (file:, ftp:, gopher:…) thì từ chối thẳng,
  // đừng tự thêm https:// phía trước rồi trông chờ DNS báo lỗi
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error("Only http/https links are supported");
  }
  const input = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const notes: string[] = [];

  // Thử lại một lần khi bị ngắt: lúc server vừa khởi động nguội (Cloud Run đặt
  // min-instances=0) request đầu hay quá giờ dù trang tải chưa tới 1 giây.
  const opts = { maxBytes: 2_500_000, timeoutMs: 12000, accept: "text/html,*/*" };
  let page: Fetched;
  try {
    try { page = await safeFetch(input, opts); }
    catch (e: any) {
      if (e?.name !== "AbortError" && !/abort/i.test(e?.message || "")) throw e;
      page = await safeFetch(input, opts);
    }
  } catch (e: any) {
    // Trang chặn máy chủ (403/429/503… — vinamilk.com.vn trả 403 cho IP Cloud Run
    // dù ở máy local vẫn qua) → vẫn cố trả kết quả từ favicon qua Google.
    if (e?.status || e?.name === "AbortError" || /abort|fetch failed/i.test(e?.message || "")) {
      const fb = await fallbackFromFavicon(input);
      if (fb) return fb;
    }
    throw e;
  }
  if (!/html|xml|text\/plain/.test(page.type) && page.type) throw new Error("That link isn't a web page");
  const html = page.body.toString("utf8");
  const base = page.url;

  // CSS: <style> trong trang + tối đa 4 file CSS ngoài
  const css: string[] = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).map((s) => s.replace(/<\/?style[^>]*>/gi, ""));
  const inline = (html.match(/\bstyle\s*=\s*"[^"]*"/gi) || []).join("\n");
  css.push(inline);
  const cssLinks = (html.match(/<link\b[^>]*>/gi) || [])
    .filter((t) => /stylesheet/i.test(attr(t, "rel")) && attr(t, "href"))
    .map((t) => abs(attr(t, "href"), base))
    .filter((u) => u && !/fonts\.googleapis|use\.typekit|fontawesome/i.test(u))
    .slice(0, 4);
  const cssResults = await Promise.allSettled(cssLinks.map((u) => safeFetch(u, { maxBytes: 1_500_000, timeoutMs: 6000, accept: "text/css,*/*" })));
  cssResults.forEach((r) => { if (r.status === "fulfilled") css.push(r.value.body.toString("utf8")); });
  const cssOk = cssResults.filter((r) => r.status === "fulfilled").length;
  if (cssLinks.length) notes.push(`đọc được ${cssOk}/${cssLinks.length} file CSS`);

  // manifest
  let manifest: any = null, manifestUrl = "";
  const mLink = (html.match(/<link\b[^>]*rel\s*=\s*["']?manifest[^>]*>/i) || [""])[0];
  if (mLink && attr(mLink, "href")) {
    manifestUrl = abs(attr(mLink, "href"), base);
    try {
      const mf = await safeFetch(manifestUrl, { maxBytes: 200_000, timeoutMs: 5000, accept: "application/json,*/*" });
      manifest = JSON.parse(mf.body.toString("utf8"));
    } catch { notes.push("không đọc được manifest"); }
  }

  const colors = collectColors(html, css, manifest);
  const logos = collectLogos(html, base, manifest, manifestUrl, css.join("\n"));
  // màu tra được từ chính logo SVG thì đứng đầu danh sách
  for (const lc of logos.colors.reverse()) {
    const i = colors.findIndex((c) => c.hex === lc.hex);
    if (i >= 0) colors.splice(i, 1);
    colors.unshift(lc);
  }

  // logo: thử lần lượt từ ứng viên tốt nhất, cái nào tải được là lấy
  let logo: BrandResult["logo"] = null;
  let usedIdx = -1;
  const cands = logos.list.slice(0, 8);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (c.inlineSvg) {
      let svg = c.inlineSvg;
      if (!/xmlns=/.test(svg)) svg = svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
      logo = { dataUrl: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"), source: c.source, mono: c.mono };
      usedIdx = i;
      break;
    }
    const dataUrl = await fetchImage(c.url!);
    if (dataUrl) { logo = { dataUrl, source: c.source, url: c.url }; usedIdx = i; break; }
  }

  // Logo một màu thì không có màu hãng để đọc → lấy thêm một icon có màu thật
  // (favicon, icon Apple, icon manifest) chỉ để đọc màu.
  let colorImage: BrandResult["colorImage"] = null;
  if (logo?.mono) {
    for (const c of logos.list.slice(usedIdx + 1)) {
      if (!c.url) continue;
      const dataUrl = await fetchImage(c.url);
      if (dataUrl) { colorImage = { dataUrl, source: c.source }; break; }
    }
    notes.push(colorImage ? `logo một màu — đọc màu hãng từ ${colorImage.source}` : "logo một màu, không có icon màu để đọc");
  }

  if (!logo) notes.push("không tìm thấy logo tải được");
  if (!colors.length) notes.push("không thấy màu thương hiệu trong HTML/CSS — sẽ lấy màu từ logo");

  return { url: base, name: cleanName(html), logo, colorImage, colors, notes };
}
