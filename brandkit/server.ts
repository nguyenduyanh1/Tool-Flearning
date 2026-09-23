// Brand Kit — dán link website, tool lấy logo/màu hãng rồi áp vào bộ slide.
// Một tiến trình Node: phục vụ trang tĩnh trong public/ và 3 API. Không gọi AI.
//
// Chạy: node server.ts   (Node ≥ 22.18 chạy thẳng TypeScript, không cần build)

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { extractBrand } from "./lib/brand-extract.ts";
import { saveLead, onCloudRun } from "./lib/firestore.ts";
import { submitHubSpotLead } from "./lib/hubspot.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === "production";

// Số slide xem tự do; từ slide sau đó phải nhập email.
const FREE_SLIDES = 5;
// Phải tên "__session": Firebase Hosting xoá mọi cookie khác trước khi chuyển yêu cầu
// sang Cloud Run. Cookie gắn Path=/brandkit nên tool khác trên cùng tên miền dùng
// __session của riêng nó (Path khác) mà không giẫm lên vé của Brand Kit.
const COOKIE = "__session";

// Khoá ký "vé" mở khoá. Trên server thật BẮT BUỘC có BRANDKIT_SECRET — thiếu thì
// dừng luôn (thà lỗi to): khoá ngẫu nhiên sẽ đổi mỗi lần máy khởi động lại, vé cũ
// của khách mất hiệu lực mà không ai biết vì sao.
if (PROD && !process.env.BRANDKIT_SECRET) {
  console.error("Thiếu biến môi trường BRANDKIT_SECRET");
  process.exit(1);
}
const secret = createHash("sha256")
  .update("brandkit-unlock:" + (process.env.BRANDKIT_SECRET || randomBytes(32).toString("hex")))
  .digest();
const sign = (exp: string) => createHmac("sha256", secret).update(exp).digest("hex");

function unlocked(req: express.Request): boolean {
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=(\\d+)\\.([0-9a-f]{64})"));
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(sign(m[1]), "hex"), b = Buffer.from(m[2], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// IP người gọi, dùng để giới hạn tần suất. Cloud Run luôn gắn IP nơi gửi tới vào CUỐI
// X-Forwarded-For (phần trước người gọi tự bịa được):
// - vào thẳng link run.app: "<tự gửi…>, <IP khách>"      → lấy phần tử cuối
// - qua Firebase Hosting (brandkit-flearning.web.app): "<IP khách>, <IP Firebase>"
//   → lấy phần tử áp chót. Đã đo thật (09/2026): Firebase xoá X-Forwarded-For khách tự
//   gửi, nên IP áp chót tin được.
// Giới hạn: kẻ rành kỹ thuật gọi thẳng run.app kèm header Firebase giả thì lách được
// giới hạn. Chấp nhận — đây chỉ là chống spam, API không gọi AI nên không tốn tiền.
function clientIp(req: express.Request): string {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  const viaHosting = !!req.headers["x-firebase-hosting-channel"] && xff.length >= 2;
  return (viaHosting ? xff[xff.length - 2] : xff[xff.length - 1]) || req.socket.remoteAddress || "unknown";
}

// Giới hạn tần suất theo IP. true = còn lượt. Bảng đếm tự dọn khi quá lớn.
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}
const extractLimit = limiter(20, 10 * 60_000);   // 20 lần đọc website / 10 phút
const leadLimit = limiter(10, 60 * 60_000);      // 10 lần nhập email / giờ

// Tool nằm dưới /brandkit của tool-flearning.web.app (mỗi tool một ngăn, một service
// Cloud Run riêng). Firebase Hosting chuyển nguyên đường dẫn /brandkit/... sang đây.
const BASE = "/brandkit";

const app = express();
app.disable("x-powered-by");
const tool = express.Router();
tool.use(express.json({ limit: "10kb" }));

// Firebase Hosting có CDN đứng trước. Không cho CDN giữ bản sao chung:
// - API: không lưu đệm (kết quả tuỳ từng người, từng lần)
// - template: "private" = chỉ trình duyệt của chính khách được giữ. Nếu CDN giữ bản
//   slide 6+ của một khách đã mở khoá, khách khác sẽ nhận luôn bản đó → mất khoá.
tool.use((req, res, next) => {
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  else if (req.path.startsWith("/templates/")) res.setHeader("Cache-Control", "private, max-age=3600");
  else res.setHeader("Cache-Control", "private, max-age=300");
  next();
});

// Chốt khoá slide đặt TRƯỚC express.static. File của slide 6+ (template.json, ảnh,
// thumb) chỉ trả khi có vé hợp lệ. Chuẩn hoá đường dẫn trước khi so (giải mã %xx,
// gộp // và ./, ../) để không lách bằng cách viết đường dẫn khác đi.
tool.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { return res.status(400).end(); }
  p = path.posix.normalize(p.replace(/\\/g, "/"));
  const m = p.match(/^\/templates\/[^/]+\/p0*(\d+)(?:\/|$)/i);
  if (m && Number(m[1]) > FREE_SLIDES && !unlocked(req)) {
    // no-store: nếu trình duyệt nhớ câu "bị khoá" thì nhập email xong vẫn thấy khoá
    res.setHeader("Cache-Control", "no-store");
    return res.status(403).type("text/plain").send("Enter your email to see all slides");
  }
  next();
});

// Đọc logo, tên, màu hãng từ website. Chặn địa chỉ nội bộ nằm trong lib/brand-extract.
tool.get("/api/brand-extract", async (req, res) => {
  if (!extractLimit(clientIp(req))) return res.status(429).json({ error: "Too many requests. Try again in a few minutes." });
  const target = String(req.query.url || "").trim();
  if (!target) return res.status(400).json({ error: "Paste a website link first" });
  try {
    res.json(await extractBrand(target));
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Couldn't read this website" });
  }
});

tool.get("/api/unlocked", (req, res) => {
  res.json({ unlocked: unlocked(req), free: FREE_SLIDES });
});

// Nhập email → lưu vào Firestore (collection leads) → gắn cookie vé, sống 30 ngày.
tool.post("/api/lead", async (req, res) => {
  if (!leadLimit(clientIp(req))) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  const lead = {
    email,
    site: String(req.body?.site || "").slice(0, 300),
    template: String(req.body?.template || "").slice(0, 60),
    createdAt: new Date().toISOString(),
  };
  if (onCloudRun()) {
    // Không lưu được thì không mở khoá — mục đích của bước này là thu email.
    if (!(await saveLead(lead))) return res.status(503).json({ error: "Couldn't save right now. Try again shortly." });
    // HubSpot form là nguồn quản lý lead chính. Không nhận được form submission thì
    // không mở khoá, tránh trường hợp khách lấy đủ deck nhưng lead bị thất lạc.
    const hutk = String(req.body?.hutk || "").slice(0, 200);
    if (!(await submitHubSpotLead(email, hutk))) return res.status(503).json({ error: "Couldn't save right now. Try again shortly." });
  } else {
    console.log("[máy local] không lưu Firestore/HubSpot, chỉ ghi log:", lead.email);
  }
  const exp = String(Date.now() + 30 * 86400_000);
  res.setHeader("Set-Cookie", `${COOKIE}=${exp}.${sign(exp)}; Path=${BASE}; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax`
    + (PROD ? "; Secure" : ""));
  res.json({ ok: true });
});

// cacheControl: false = giữ nguyên header Cache-Control đặt ở trên
tool.use(express.static(path.join(ROOT, "public"), { extensions: ["html"], cacheControl: false }));

// "/brandkit" (thiếu dấu /) → "/brandkit/": trang dùng đường dẫn tương đối (engine.js,
// templates/, api/), thiếu dấu / thì trình duyệt tính sai thư mục.
app.get(BASE, (req, res, next) => {
  if (req.path !== BASE) return next();          // express không phân biệt "/brandkit/" — chỉ bắt đúng bản thiếu /
  const q = req.originalUrl.indexOf("?");
  res.redirect(301, BASE + "/" + (q >= 0 ? req.originalUrl.slice(q) : ""));
});
app.use(BASE, tool);
// Mở thẳng link run.app (không qua Hosting) → đưa vào tool
app.get("/", (req, res) => res.redirect(302, BASE + "/"));

app.listen(PORT, "0.0.0.0", () => console.log(`Brand Kit chạy ở http://localhost:${PORT}`));
