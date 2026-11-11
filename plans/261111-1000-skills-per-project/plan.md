# Cài skill cho dự án từ Telegram (/skills)

**Status:** Done · **Priority:** Medium

## Mục tiêu
Trong topic đã gắn dự án, `/skills` mở bảng nút: chọn nguồn (Ponytail, ClaudeKit) → danh sách skill của nguồn
(có trang, ✓ = đã có trong dự án) → bấm để cài vào `<dự án>/.claude/skills/<tên>`, bấm lại để gỡ.

## Dữ kiện (máy người dùng)
- Ponytail là plugin (`ponytail@ponytail`, cài user scope). Skill nằm ở `installPath/skills/*` trong
  `~/.claude/plugins/installed_plugins.json` (dự phòng: `plugins/marketplaces/ponytail/skills`). Skill tự đủ,
  không trỏ ra ngoài thư mục của nó.
- ClaudeKit: skill nằm chung `~/.claude/skills` với bmad, ccgs… Nhận ra bằng frontmatter `author: claudekit`
  hoặc `name: ck:…` / `ckm:…` (77 skill). Skill ClaudeKit trỏ tới `~/.claude/skills/...` bằng đường tuyệt đối → chép vẫn chạy.
- `ck skills --name X` cũng chỉ chép thư mục từ `~/.claude/skills`; `ck` là `.cmd` trên Windows (phải qua cmd.exe)
  → bot tự chép, không gọi `ck`.
- `chrome-devtools/scripts/node_modules` 72 MB, `__pycache__`: bỏ qua khi chép.

## Thiết kế
- `config.ts`: `claudeDir` = `CLAUDE_CONFIG_DIR` hoặc `~/.claude`.
- `skill-sources.ts`: danh sách nguồn (thêm nguồn = thêm 1 phần tử) + đọc skill của nguồn (tên thư mục, mô tả).
- `project-skill-install.ts`: cài = chép sang thư mục tạm rồi rename (không để skill dở dang); gỡ chỉ khi
  `SKILL.md` trong dự án giống hệt bản nguồn (không xoá skill riêng / đã sửa của dự án).
- `topic-skill-choice.ts`: `/skills` + nút bấm. Dữ liệu nút ghi sẵn hành động (`+tên` / `-tên`): bấm đúp không
  cài rồi gỡ ngay. Tên skill phải có trong danh sách nguồn (chặn `../`).
- `bot-commands.ts`, `message-router.ts`: menu, help, chuyển nút `skills:` sang handler mới.

## Các bước
- [x] 1. config + nguồn skill + cài/gỡ
- [x] 2. /skills, nút bấm, menu, help
- [x] 3. Test: bảng, cài (bỏ node_modules), gỡ, không gỡ bản đã sửa, nút giả mạo, bấm đúp, chưa gắn dự án, thiếu nguồn
- [x] 4. Typecheck + test (109/109; tắt kiểm tra SKILL.md hoặc bộ lọc node_modules → test fail), review, README

## Review (code-reviewer) → đã sửa, test mới thấy fail trước khi sửa
- H1 topic gắn vào thư mục home → `.claude/skills` của dự án chính là nguồn → bấm ✓ xoá skill global.
- H2 chỉ so SKILL.md rồi xoá cả thư mục → mất `.env`, references đã sửa của dự án.
- M5 nguồn cập nhật → bản chưa sửa vẫn bị coi là "đã sửa", kẹt.
  Sửa cả 3: mỗi bản cài có `.router-skill.json` (sha256 từng tệp); chỉ gỡ khi có manifest và mọi tệp khớp.
- M3 chép cả `.env` của skill vào dự án → lọc theo SECRET_NAME (dùng chung với gửi tệp).
- M4 Windows: tệp bị khoá → xoá dở, kẹt. Sửa: rename sang thư mục rác trước (tệp khoá thì rename lỗi, skill còn nguyên) rồi xoá.
- M6 ClaudeKit `_shared` / `common` (require tương đối) → chép kèm khi cài (không có SKILL.md, không gỡ).
- L7 bảng cũ sau /bind thư mục khác → bấm tác động thư mục mới. Sửa: bảng ghi `📁 <thư mục>`; khác thư mục hiện tại → vẽ lại, không làm gì.
- L8 link/junction trong skill → bỏ qua (Windows không có quyền tạo symlink). L10 thư mục tạm bỏ pid → lần sau dọn được.
- Để lại: L9 cpSync đồng bộ (skill lớn nhất ~0.8 s chặn bot); đổi sang async cần khoá theo tên skill.

## Thành công khi
- `/skills` → ClaudeKit → bấm `cook` → `<dự án>/.claude/skills/cook/SKILL.md` có, nút hiện ✓; bấm lại → gỡ.
- Toàn bộ test qua.
