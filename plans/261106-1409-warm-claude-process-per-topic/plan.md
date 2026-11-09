# Giữ sẵn tiến trình Claude cho mỗi topic (warm process)

**Status:** Done · **Priority:** High

## Mục tiêu
Tin nhắn trong topic đi thẳng vào một tiến trình Claude đang chạy sẵn, không khởi động lại mỗi tin.
Tin gửi khi Claude đang làm được Claude đọc ở bước kế tiếp, không phải xếp hàng chờ.

## Dữ kiện (đo trên Claude Code 2.1.318, Haiku, thư mục trống)
- `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`
  nhận nhiều tin qua stdin trong một tiến trình; mỗi lượt có `system/init` + `result`, cùng session id.
- Tin đầu (khởi động): ~3,4–4 s. Tin sau (đang nóng): ~1,4 s. Tiết kiệm ~2 s mỗi tin.
- Tin gửi khi đang bận: Claude đọc ở bước kế tiếp, trả lời gộp trong cùng một `result`.
  Tin được đọc lúc nào: dòng `user` có `isReplay: true`.
- `control_request` `{subtype:'interrupt'}` ngắt lượt (~10 ms), tiến trình vẫn sống.
- `--resume <id>` dùng được với chế độ này. Đóng stdin → thoát ~0,5 s.

## Thiết kế
- `claude-runner.ts` (viết lại, class `ClaudeLiveSession`): một tiến trình sống lâu; `send(text)`, `close()`, `kill()`, sự kiện ra.
- `topic-conversations.ts` + `topic-busy-period.ts` (mới): mỗi topic một "busy period" chạy trong `RunScheduler`
  (giữ giới hạn `MAX_PARALLEL_RUNS`). Topic rảnh + có tin → bắt đầu busy period, mở tiến trình nếu chưa có.
  Topic bận + có tin → ghi thẳng vào stdin, trả lời ngắn "📨 Đã gửi vào việc đang chạy".
  Mỗi `result` = một lượt: sửa tin ⏳ thành tổng kết, gửi câu trả lời, báo độ lớn phiên.
  Tin chưa được đọc khi lượt kết thúc → Claude tự mở lượt mới, bot mở tin ⏳ mới.
- Không tự tắt khi rảnh (quyết định của người dùng): tiến trình sống đến khi /stop, /new, /bind, /unbind hoặc tắt bot.
- `/stop`: giết cả cây tiến trình như cũ; tin sau mở lại với `--resume`.
- `/new`, `/bind`, `/unbind` (khi rảnh): đóng tiến trình của topic.
- Phiên cũ không còn ("No conversation found") → bỏ phiên, mở lại không `--resume`, gửi lại các tin chưa đọc.
- Quá `RUN_TIMEOUT_MINUTES` trong một lượt → giết tiến trình như cũ.
- `claude-runner.ts`: bỏ `startClaudeRun` (một lần một tin), giữ env sạch, `TELEGRAM_NOTE`, đọc dòng.
- `claude-stream-events.ts`: event `replay`. `/status`: trạng thái tiến trình (nóng / đang làm / tắt).

## Các bước
- [x] 1. `claude-live-session.ts` + event `replay`
- [x] 2. `topic-conversation.ts`: busy period, lượt, chèn tin, idle, stale session, crash
- [x] 3. Nối vào message-router, bot-commands, config; gỡ đường chạy cũ
- [x] 4. fake-claude chạy chế độ stream-json (nhiều tin, chèn tin, interrupt, SLOW, CRASH, STALE)
- [x] 5. Test: dùng lại tiến trình, chèn tin khi bận, /stop, stale, crash, tiến trình chết khi rảnh, cảnh báo phiên
- [x] 6. Typecheck + test (66/66 × 3), 2 lượt review, README

## Thành công khi
- Tin thứ hai trong topic dùng lại cùng tiến trình (test kiểm tra pid).
- Tin gửi khi đang bận có trả lời "📨" ngay, nằm trong câu trả lời của lượt đang chạy.
- /stop, timeout, Ctrl+C vẫn dừng cả cây tiến trình. Toàn bộ test qua.

## Rủi ro
- Chế độ stream-json input ít tài liệu; có thể đổi giữa các bản Claude Code → parse mềm, test bằng fake.
- RAM: ~150–180 MB mỗi topic đang nóng, đến khi /stop.
- Lệnh nền Claude mở (dev server) sống theo tiến trình đến khi idle / /stop.

## Review 1 (code-reviewer) → đã sửa, có test hồi quy (thấy fail trước khi sửa)
- H1 tin ngay sau /stop bị bỏ (cả khi đang chờ slot) → /stop tách period khỏi topic; `TopicConversations.stop`.
- H2 tiến trình thay thế mở trước khi tiến trình cũ chết hẳn → `claudeProcessFor` chờ `ended`; mỗi lượt có timer riêng.
- M1 sự kiện gửi theo `conv.period` → gửi cho `proc.owner` (`topic-claude-process.ts`).
- M2 câu trả lời sai thứ tự → `queueReport` nối tiếp theo topic; period chỉ xong khi đã gửi hết.
- M3 lỗi trong chuỗi `void` → bắt lỗi từng tin; thoát bất thường cũng giết cây tiến trình.
- L1 hàng chờ đầy, L2 vòng lặp phiên cũ, L3 lời báo khi chờ slot, L5 timer 5 s: đã sửa.
- Thử thật: tin bắt đầu bằng "/" vẫn được replay và trả lời; 2 tin liền nhau vào tiến trình rảnh = 2 lượt.
- Tách file: `topic-claude-process.ts`, `topic-turn.ts`; mọi file ≤ 200 dòng. Test 65/65 (3 lần).

## Review 2 (xác minh)
- Cả 12 lỗi của review 1 đã sửa; không có lỗi mới mức cao / trung bình.
- LOW-1 (/stop lúc đang chờ tiến trình cũ chết vẫn mở Claude mới rồi giết) → đã sửa, có test.
- Để lại, có lý do: LOW-2 (sau /stop một topic đang chờ slot, topic khác có thể chạy trước — chỉ sai
  thứ tự công bằng, cần sửa RunScheduler); LOW-3 (topic giữ slot trong lúc gửi câu trả lời khi Telegram
  bắt chờ — cái giá của việc giữ thứ tự câu trả lời, có giới hạn thời gian).
