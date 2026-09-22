# Template cho Brand Kit (`Brand Kit`)

Mỗi template là **dữ liệu** (`public/templates/<id>/`), không phải code. Tool đọc
`templates/index.json` để biết có template nào và dùng chung một bộ vẽ (`publicBrand Kit/engine.js`).
Web không phân tích file thiết kế — template được dựng và **soát trước** rồi mới đưa lên.

## Cách dựng một template

1. **File thiết kế:** `.ai` (lưu với *Create PDF Compatible File*) hoặc `.pdf` còn vector và chữ thật.
   PDF kiểu ảnh bẹt (mỗi trang một tấm JPEG) không dùng được. Nền trang nên nằm trên một layer
   riêng (D60: layer `BG`). Chép file vào `templates-src/` (không đưa lên git — tài liệu của khách).

2. **Cấu hình** `scripts/templates/<id>.json` (chép từ `d60-p1.json`):

   | Trường | Nghĩa |
   |---|---|
   | `id`, `name` | tên thư mục / tên hiện ở ô chọn |
   | `source`, `page` | file trong `templates-src/`, trang thứ mấy (đếm từ 0) |
   | `bgLayer`, `hideLayers` | tên layer nền (mặc định `BG`), các layer bỏ qua (mặc định `Guide`) |
   | `baseHue` | tông màu hãng gốc của thiết kế (độ, 0–360; D60 ≈ 195) |
   | `defaultColor`, `defaultName` | hiện khi người dùng chưa áp brand |
   | `logoSlots` | ô logo cũ (pt, gốc trên-trái) — mọi hình/chữ trong ô bị bỏ, tool vẽ logo mới vào |

3. **Dựng:** `node scripts/build-template.mjs scripts/templates/<id>.json`

   Máy dựng đứng giữa lúc MuPDF vẽ file và chia từng lệnh vẽ theo layer của nó:
   nền gốc (bỏ, tool tự sinh), trang trí nền (`decor`), chữ (vector, đúng hình chữ font gốc),
   hình. Lớp hình tách thành: `card` (minh hoạ, giữ nguyên kèm chữ trong nó và bóng đổ thật),
   `panel` (tấm nền lớn — giữ ảnh, nhưng chữ trên nó vẽ lại bằng vector), `shape` (nhãn/icon nhỏ,
   mỗi màu một lớp để tô lại), `image` (khối chuyển màu). Mỗi đoạn chữ ghi `on` = nó nằm trên gì.

4. **Soát — bắt buộc trước khi đưa lên.** Máy dựng xuất bản gốc vào `verify/` (không lên git).
   - Vẽ template ở chế độ `{ original: true }` rồi so từng pixel với `verify/page.png`,
     có dung sai 1 px cho viền. D60 đạt sai lệch ~1,5%, phần còn lại là viền mờ.
   - Áp thử ≥ 3 màu rất khác nhau (một rất nhạt, một tầm trung như cam, một rất đậm), nhìn
     từng vùng; đo mọi đoạn chữ đạt ≥ 4,5:1 với cái nằm dưới.
   - Soi một vùng theo từng lớp: `--dump x,y,w,h` → `verify/dump.png` (hình | chữ | hình+chữ).

## Luật màu (`engine.js`, dùng chung)

- Nền: dải chéo sinh từ màu hãng; `decor` và `image` thuộc họ màu hãng xoay tông.
- `shape` `brand`: dùng thẳng tông của hãng, giữ đậm nhạt gốc, tách khỏi cái nằm dưới ≥ 1,7:1.
- `shape` `ink` (trắng/đen): giữ màu gốc nếu còn tách được khỏi nền (≥ 1,5:1).
- Chữ: đạt ≥ 4,5:1 (WCAG AA) với đúng cái nằm dưới **từng đoạn**; mực ưu tiên trắng → màu tối
  cùng tông hãng → đen.
- `keep`: màu mang nghĩa (đỏ, lục, vàng) giữ nguyên.

## Giới hạn đã biết

- Chi tiết màu hãng nằm lẫn trong ảnh `card`/`panel` (vd đường lượn sóng dưới tiêu đề trang 2)
  giữ màu gốc.
- Chữ nằm trong card (nhãn trong minh hoạ) giữ nguyên, không đổi màu.
- Chữ nội dung (tên sản phẩm, email, website trong bài) giữ nguyên — chỉ ô logo được thay.

## Bộ slide nhiều trang (vd `mpc.json` — deck Canva xuất PDF)

- `"pages": "all"` (hoặc mảng số trang, đếm từ 0): máy dựng chạy từng trang một tiến trình riêng,
  ghi `templates/<id>/pNN/` + `deck.json`, đăng ký cả bộ là **một** template (`pages: N`).
- File Canva không có layer: hình phủ ≥ 85% trang được coi là nền gốc.
- `"background": "keep"`: giữ nền gốc (vd nền kem), chỉ đổi màu khung/tiêu đề/chữ theo hãng.
- `"bakeCardText": false`: chữ trong khung là nội dung slide → vẽ lại để đổi màu theo nền khung.
- `"scale": 2`: slide 1440 pt ×2 là đủ nét; ×4 làm bộ slide nặng vài chục MB.
- Ô logo `"add": true`: thêm logo mới ở chỗ trống (không có logo cũ để xoá).
- Trang web: xem từng slide (nút ‹ ›, dải ảnh nhỏ), **Download PDF** vẽ lần lượt mọi slide
  với brand hiện tại rồi ghép bằng jsPDF (tải từ cdnjs khi bấm).
