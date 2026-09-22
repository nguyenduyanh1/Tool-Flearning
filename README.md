# F.Learning Tools

Bộ tool miễn phí của F.Learning Studio, chung một địa chỉ: **https://tool-flearning.web.app**

| Đường dẫn | Là gì | Code |
|---|---|---|
| `/` | Trang sảnh — danh sách tool | `hub/index.html` |
| `/brandkit/` | Brand Kit — dán link website, ra bộ slide theo brand | `brandkit/` (xem `brandkit/README.md`) |

## Cách tổ chức

Firebase Hosting (site `tool-flearning`) là "sảnh chính":
- trang sảnh là file tĩnh trong `hub/`
- mỗi tool là **một service Cloud Run riêng**, Hosting chuyển `/<tool>/...` sang đó
  (cấu hình trong `firebase.json`). Tool này lỗi hay deploy lại không ảnh hưởng tool khác.

Tất cả nằm trong project Google Cloud `hale-tractor-434715-s1` (vùng Singapore).
Site cũ `brandkit-flearning.web.app` chỉ còn tự chuyển sang `/brandkit/`.

## Thêm một tool mới

1. Tạo thư mục `<tool>/` với server riêng. Mọi route gắn dưới `/<tool>` (xem `BASE` trong
   `brandkit/server.ts`), trang dùng đường dẫn tương đối.
2. Deploy thành service Cloud Run mới, **luôn** `--min-instances=0 --max-instances=1`.
3. Thêm 2 rewrite vào `firebase.json` (site `tool-flearning`):
   `/<tool>` và `/<tool>/**` → `{ "run": { "serviceId": "<service>", "region": "asia-southeast1" } }`.
4. Thêm một dòng vào mảng `TOOLS` đầu `hub/index.html`.
5. Deploy Hosting: `npx firebase-tools deploy --only hosting`.

Lưu ý khi đi qua Firebase Hosting:
- Hosting xoá mọi cookie trừ `__session` → tool cần cookie thì dùng tên đó, gắn `Path=/<tool>`.
- Hosting có CDN → nội dung riêng từng người phải gửi kèm `Cache-Control: private` hoặc `no-store`.
- IP khách nằm ở phần tử **áp chót** của `X-Forwarded-For`.

Tool tĩnh hoàn toàn (không cần server) thì bỏ bước 2–3, đặt thẳng vào `hub/<tool>/`.

## Chi phí

Giữ trong hạn mức miễn phí: Cloud Run `min-instances=0` (không có khách thì không tốn tiền),
`max-instances=1` là lá chắn chi phí — không tăng nếu chưa bàn.
