# Brand Kit

Dán link website → tool tự lấy logo, tên và màu thương hiệu → áp vào bộ slide có sẵn →
tải về PDF. Không dùng AI.

Khách xem tự do 5 slide đầu. Muốn xem hết hoặc tải PDF thì nhập email; email được lưu
vào Firestore (collection `leads`). Khoá nằm ở server: file của slide 6 trở đi chỉ được
trả về khi trình duyệt có "vé" (cookie có chữ ký) cấp sau khi nhập email.

## Cấu trúc

| Phần | Vị trí |
|---|---|
| Server (trang tĩnh + 3 API) | `server.ts` |
| Đọc logo/màu từ website (chặn địa chỉ nội bộ) | `lib/brand-extract.ts` |
| Ghi email vào Firestore | `lib/firestore.ts` |
| Trang web | `public/index.html` |
| Bộ vẽ template (đổi màu, tương phản chữ, logo) | `public/engine.js` |
| Template đã dựng | `public/templates/` |
| Máy dựng template từ file .ai/.pdf | `scripts/build-template.mjs` + `scripts/templates/*.json` |
| Xuất email ra CSV | `scripts/export-leads.mjs` |

API: `GET /api/brand-extract?url=`, `GET /api/unlocked`, `POST /api/lead`.

## Chạy trên máy

Cần Node ≥ 22.18 (chạy thẳng TypeScript, không có bước build).

```bash
npm install
npm run dev
```

Mở http://localhost:3000/brandkit/. Ở máy local, email **không** được lưu vào Firestore (chỉ ghi log)
nhưng vẫn mở khoá, để thử được cả luồng.

Trước khi commit: `npm run lint` phải sạch.

## Link cho khách

**https://tool-flearning.web.app/brandkit/** — Firebase Hosting (sảnh chung, xem README ở
gốc repo) chuyển mọi yêu cầu `/brandkit/...` sang service Cloud Run `brandkit-flearning`
(project `hale-tractor-434715-s1`, vùng Singapore). Link cũ `brandkit-flearning.web.app`
tự chuyển sang link này.

Mọi route của server gắn dưới `/brandkit` (hằng `BASE` trong `server.ts`); trang dùng đường
dẫn tương đối nên không phải sửa khi đổi ngăn.

Vì đi qua Hosting nên:
- cookie vé phải tên `__session` (Hosting xoá mọi cookie khác), gắn `Path=/brandkit` để tool
  khác cùng tên miền không giẫm lên
- file template gửi kèm `Cache-Control: private` để CDN không giữ bản đã mở khoá
- IP khách nằm ở phần tử **áp chót** của `X-Forwarded-For` (xem `clientIp` trong `server.ts`)

## Deploy lên Cloud Run

Biến môi trường bắt buộc: `BRANDKIT_SECRET` — chuỗi ngẫu nhiên dài, dùng ký "vé" mở khoá.
Thiếu biến này server sẽ không khởi động. Đổi giá trị = mọi vé cũ mất hiệu lực (khách
phải nhập lại email).

Chạy trong thư mục `brandkit/`:

```bash
gcloud run deploy brandkit-flearning --source . --project=hale-tractor-434715-s1 --region=asia-southeast1 \
  --min-instances=0 --max-instances=1 --allow-unauthenticated
```

Lần đầu thêm `--set-env-vars=BRANDKIT_SECRET=...`. Các lần sau **không** truyền lại, biến
đã lưu trên service.

Project cần bật Firestore (database `(default)`, chế độ Native). Service account mặc định
của Cloud Run cần quyền `Cloud Datastore User`.

`min-instances=0`, `max-instances=1` là lá chắn chi phí: không có khách thì không tốn tiền,
đổi lại người đầu tiên vào sau lúc vắng chờ vài giây.

## Xem email khách

```bash
npm run export-leads -- hale-tractor-434715-s1
```

File CSV ghi ra thư mục `leads-export/` **cạnh** thư mục repo (vd `D:\leads-export\`) — cố ý
để ngoài repo vì chứa email khách. `.gitignore` cũng chặn mọi file `.csv`.

## Thêm template mới

Xem `scripts/templates/README.md`. File thiết kế gốc đặt trong `templates-src/` (không lên git).

```bash
npm run build-template -- scripts/templates/mpc.json
```
