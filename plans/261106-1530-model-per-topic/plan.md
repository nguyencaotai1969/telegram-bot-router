# Chọn model cho từng topic trên Telegram

**Status:** Done · **Priority:** Medium

## Mục tiêu
Trong mỗi topic, người dùng chọn model Claude (fable / opus / sonnet / haiku / tên đầy đủ) bằng lệnh
Telegram. Lựa chọn lưu theo topic, giữ qua `/new`, `/stop`, khởi động lại bot.

## Dữ kiện
- `claude --help` (2.1.318): `--model` nhận alias `fable`, `opus`, `sonnet` hoặc tên đầy đủ; `haiku` đã chạy được khi thử.
- `--resume` với model khác vẫn giữ ngữ cảnh phiên.
- Model mặc định hiện nay: `CLAUDE_MODEL` trong `.env` (để trống = mặc định của Claude Code).

## Thiết kế
- `topic-store.ts`: `TopicBinding.model?`, `setModel()`; giữ model khi `/bind` lại.
- `topic-claude-process.ts`: tiến trình chạy với `binding.model ?? config.claudeModel`.
- `bot-commands.ts` + `topic-model-choice.ts`: `/model` hiện bảng nút (Fable / Opus / Sonnet / Haiku / Mặc định); `/model <tên>`; nút bấm = callback_query, kiểm tra người dùng + group như tin nhắn.
  Quyết định của người dùng: đang chạy việc → nhận, áp dụng khi Claude rảnh (không ngắt việc đang chạy).
- Kiểm tra tên model như `CLAUDE_MODEL` (dùng chung hàm trong `config.ts`).
- `/status` hiện model của topic. Menu lệnh thêm `/model`.

## Các bước
- [x] 1. Store + process dùng model của topic
- [x] 2. Lệnh /model, /status, menu, help
- [x] 3. Test: lưu/khôi phục, tiến trình mới chạy đúng `--model`, từ chối khi bận, tên sai
- [x] 4. Typecheck + test (77/77 × 2), review, README

## Thành công khi
- `/model opus` rồi nhắn tin → Claude chạy với `--model opus`, cùng phiên (test kiểm tra qua fake-claude).
- Khởi động lại bot vẫn giữ model của topic. Toàn bộ test qua.

## Review (code-reviewer) → đã sửa, test hồi quy thấy fail trước khi sửa
- M1 bấm nút trên bảng /model đã cũ (Telegram gửi message không có topic, date 0) → đổi nhầm model topic General.
  Sửa: date 0 → báo "bảng đã cũ, gõ /model".
- M2 đổi model = giết tiến trình + mọi lệnh nền Claude mở. Sửa: đổi tại chỗ bằng control request `set_model`
  (thử thật trên 2.1.318: control_response success; lượt kế tiếp init + assistant đều chạy model mới, kể cả khi
  gửi tin ngay sau set_model). Chỉ "Mặc định" khi không có CLAUDE_MODEL mới khởi động lại — và báo trước.
- L1 bấm nhanh 2 lần → bảng hiện sai model. Sửa: sửa bảng trước, trả lời nút sau.
- L2 lưu lỗi nhưng model vẫn áp dụng; toast > 200 ký tự. Sửa: hoàn tác khi lưu lỗi; cắt 200 ký tự.
- L3 thiếu test nút bấm từ group khác / không có message: đã thêm (bỏ kiểm tra group → test fail).

## Bổ sung: đủ mọi phiên bản model (yêu cầu của người dùng)
- Claude Code 2.1.318 trả danh sách model của tài khoản qua control request `initialize` (stream-json, không gọi
  model): default (Sonnet 5.5), opus, fable, sonnet, haiku, Haiku 4.5, Sonnet 5, Opus 5, Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6.
- `set_model` không kèm tên hoặc `default` → về mặc định tại chỗ (đã thử từ haiku); tên lạ → `not_found`, giữ model cũ.
- [x] `claude-model-list.ts`: hỏi danh sách 1 lần mỗi lần chạy bot (khởi động sẵn), lỗi → dùng 4 alias.
- [x] Bảng /model: mọi model trong danh sách (2 nút/hàng); `/model <tên>` ngoài danh sách → từ chối.
- [x] Về mặc định cũng đổi tại chỗ (bỏ đường khởi động lại + cảnh báo).
- [x] Test (fake-claude trả lời initialize) 82/82 × 2, typecheck, review.
- Review danh sách model → đã sửa (test hồi quy thấy fail trước): /model <tên> lưu trước mọi bước chờ (tin
  ngay sau nó chạy model mới); /status không chờ danh sách; /model chờ tối đa 3 s rồi dùng alias; lỗi hỏi danh
  sách nhớ 5 phút; danh sách làm mới mỗi giờ (Claude Code tự cập nhật); so tên không phân biệt hoa thường;
  luôn có nút Mặc định. Để lại: chưa kiểm tra control_response của set_model (tên đã được kiểm theo danh sách;
  /status hiện model thật đang chạy).
