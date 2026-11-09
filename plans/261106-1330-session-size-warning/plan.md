# Cảnh báo phiên Claude đã nặng (ngữ cảnh lớn / nhiều tin)

**Status:** Done · **Priority:** Medium

## Mục tiêu
Khi phiên của một topic có ngữ cảnh lớn hoặc đã qua nhiều tin, bot báo ngay trong topic đó,
kèm lệnh `/new` (bấm được) để mở phiên mới.

## Dữ kiện (đo trên Claude Code 2.1.318)
- Tin `assistant` trong stream-json có `message.usage`: ngữ cảnh = input + cache_creation + cache_read (+ output).
  Chỉ tính tin của luồng chính (`parent_tool_use_id` null), bỏ tin của sub-agent.
- Dòng `result` có `modelUsage[model].contextWindow` (hiện 1.000.000).
- Phiên trống đã ~57k token (system prompt, tool, skill). Phiên sky-farm hiện ~210k.
- Cửa sổ 1M nên Claude lâu mới tự nén ngữ cảnh: ngưỡng nên tính theo token tuyệt đối, không theo %.
- `--resume` giữ nguyên session id → số liệu gắn với session id, đổi id thì đặt lại.

## Thiết kế
- `claude-stream-events.ts`: event mới `{ kind: 'context', tokens }`; `ResultEvent.contextWindow`.
- `claude-runner.ts`: `ClaudeRunOutcome.contextTokens` = số của tin luồng chính cuối cùng.
- `topic-store.ts`: `TopicBinding.usage = { messages, contextTokens, contextWindow? }`,
  xoá khi đổi / xoá phiên; `recordUsage()` trả về số liệu trước / sau.
- `session-size-warning.ts` (mới): định dạng `210k`, kiểm tra vượt ngưỡng, nội dung cảnh báo.
- `topic-run.ts`: dòng tổng kết thêm `🧠 210k`; khi đang vượt ngưỡng thêm `⚠️ … /new`.
  Mỗi phiên gửi một tin cảnh báo riêng (cờ `warned`), lần đầu thấy vượt ngưỡng. Không gửi lại mỗi tin.
- `bot-commands.ts`: `/status` hiện ngữ cảnh + số tin của phiên.
- `config.ts`: `CONTEXT_WARN_TOKENS`, `SESSION_WARN_MESSAGES` (0 = tắt).

## Các bước
- [x] 1. Parse usage + contextWindow (stream events, runner)
- [x] 2. Lưu usage theo phiên (topic store)
- [x] 3. Module cảnh báo + nối vào topic-run, /status, config
- [x] 4. fake-claude phát usage; test parse / store / router
- [x] 5. Typecheck + 55/55 test, review (H1 lưu file lỗi, M1 cảnh báo lặp, L1 việc bị dừng, L3 bản sao: đã sửa, có test hồi quy), README + .env.example

## Thành công khi
- Tin vượt ngưỡng lần đầu → 1 tin cảnh báo trong đúng topic, có `/new`.
- Tin sau đó không gửi cảnh báo lại, chỉ dòng tổng kết nhắc.
- `/new` xoá số liệu; `/status` hiện số liệu.
- Sub-agent không làm sai số ngữ cảnh. Typecheck + toàn bộ test qua.

## Rủi ro
- Định dạng stream-json đổi giữa các bản Claude Code → parse mềm: thiếu trường thì không cảnh báo, không lỗi.
