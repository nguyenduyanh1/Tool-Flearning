// Ghi email khách vào Firestore qua REST, dùng service account mặc định của Cloud Run.
// Không cần thư viện Firebase hay file khoá: metadata server của Google cấp sẵn
// token và mã project cho mọi service chạy trên Cloud Run.
//
// Collection: leads (database "(default)"). Luật Firestore mặc định cấm client đọc/ghi,
// chỉ server (service account) chạm được → khách không đọc được danh sách email.

const META = "http://metadata.google.internal/computeMetadata/v1";

// Cloud Run tự đặt K_SERVICE = tên service. Không có → đang chạy trên máy.
export const onCloudRun = () => !!process.env.K_SERVICE;

async function meta(p: string): Promise<string | null> {
  try {
    const r = await fetch(META + p, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

let tokenCache: { token: string; exp: number } | null = null;
async function accessToken(): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token;
  const t = await meta("/instance/service-accounts/default/token");
  if (!t) return null;
  const d = JSON.parse(t);
  // trừ hao 60 giây để không dùng token sát giờ hết hạn
  tokenCache = { token: d.access_token, exp: Date.now() + Math.max(0, (d.expires_in ?? 3600) - 60) * 1000 };
  return tokenCache.token;
}

let projectId: string | null = process.env.FIRESTORE_PROJECT || null;

export async function saveLead(lead: Record<string, string>): Promise<boolean> {
  const token = await accessToken();
  projectId = projectId || (await meta("/project/project-id"));
  if (!token || !projectId) return false;
  const fields = Object.fromEntries(Object.entries(lead).map(([k, v]) => [k, { stringValue: v }]));
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/leads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) console.error("Ghi Firestore lỗi", r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.error("Ghi Firestore lỗi", e);
    return false;
  }
}
