// Xuất danh sách email khách (collection leads) ra file CSV. CHỈ ĐỌC, không đụng dữ liệu.
//
// Cần: đã cài gcloud và đăng nhập bằng tài khoản có quyền đọc Firestore của project.
// Chạy: npm run export-leads -- <project-id> [thư-mục-ra]
//   vd: npm run export-leads -- brandkit-flearning D:/BrandKit-Leads
// gcloud không có trong PATH thì đặt biến GCLOUD = đường dẫn tới gcloud(.cmd).
//
// Mặc định ghi ra thư mục leads-export/ NGOÀI repo (cạnh thư mục repo) vì chứa email khách.
// Mở thẳng bằng Excel được (có BOM để hiện đúng tiếng Việt).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = process.argv[2] || process.env.FIRESTORE_PROJECT;
if (!project) { console.error("Thiếu mã project: npm run export-leads -- <project-id>"); process.exit(1); }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[3] || path.join(repo, "..", "leads-export"));

const gcloud = process.env.GCLOUD || "gcloud";
const token = execSync(`"${gcloud}" auth print-access-token`, { encoding: "utf8" }).trim();
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/leads`;

const rows = [];
let pageToken = "";
do {
  const r = await fetch(`${base}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) break;                       // chưa có email nào → collection chưa tồn tại
  if (!r.ok) { console.error(`Lỗi ${r.status}: ${await r.text()}`); process.exit(1); }
  const j = await r.json();
  for (const d of j.documents || []) {
    const v = (k) => d.fields?.[k]?.stringValue ?? "";
    rows.push({ createdAt: v("createdAt"), email: v("email"), site: v("site"), template: v("template") });
  }
  pageToken = j.nextPageToken || "";
} while (pageToken);

rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const cell = (s) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
const csv = ["createdAt,email,site,template", ...rows.map((r) => [r.createdAt, r.email, r.site, r.template].map(cell).join(","))].join("\r\n");

fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `leads-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`);
fs.writeFileSync(out, "\uFEFF" + csv + "\r\n");
console.log(`${rows.length} lượt nhập (${new Set(rows.map((r) => r.email)).size} email khác nhau) → ${out}`);
