# CLAUDE.md — Luật dự án Brand Kit

Tool tách ra từ Cá Space (F.Learning Studio), chạy độc lập. Xem `README.md` cho kiến trúc.

## Người dùng

Duy Anh — dân motion graphics, không phải kỹ sư backend.
- Trả lời bằng tiếng Việt. Luôn nói *vì sao* trước khi đưa cách sửa, giải thích đánh đổi,
  dùng ví dụ đời thường thay cho thuật ngữ hạ tầng.
- UI của tool bằng tiếng Anh, tối giản: dán link → chọn template → Apply → tải về.

## Cách làm việc

- Làm từng việc nhỏ, commit từng bước. Nói rõ cách kiểm nhanh sau mỗi bước.
- Thông điệp commit tiếng Việt. **Dòng đầu thật ngắn** (≤ 40 ký tự, vd `Sửa IP chống spam`)
  vì GitHub hiện dòng này cạnh từng file; phần **vì sao** viết ở các dòng bên dưới.
- **Không** thêm dòng `Co-Authored-By` — repo chỉ đứng tên người dùng.
- Git: dùng danh tính sẵn có trên máy (`Nguyễn Duy Anh <duyanha6@gmail.com>`).
  Không bao giờ truyền `-c user.email`.
- `npm run lint` phải sạch trước khi commit.

## Bí mật và dữ liệu khách

- Không commit `.env` hay bất kỳ khoá nào. Không in giá trị secret ra màn hình.
- `BRANDKIT_SECRET` (ký vé mở khoá) chỉ nằm trên Cloud Run.
- `templates-src/` là file thiết kế của khách — không lên git, không deploy.
- Email khách chỉ xuất ra thư mục ngoài repo.

## Hạ tầng và chi phí

- Cloud Run `min-instances=0`, `max-instances=1`. Không tăng nếu chưa bàn với người dùng.
- Giữ trong hạn mức miễn phí. Trước khi thêm gì gọi API liên tục, nói ước lượng chi phí trước.
- Khách thật đang dùng service này — **luôn hỏi người dùng trước khi deploy**.
- Deploy lại **không** truyền `--set-env-vars` / `--env-vars-file` (ghi đè mất `BRANDKIT_SECRET`).

## Template

- Kết quả phải khớp file thiết kế gốc: soát bằng chế độ `{ original: true }` so với `verify/`.
- Chữ phải đạt tương phản WCAG với cái nằm ngay dưới nó (4,5:1 chữ nhỏ, 3:1 chữ ≥ 18pt).
- Chi tiết quy trình: `scripts/templates/README.md`.
