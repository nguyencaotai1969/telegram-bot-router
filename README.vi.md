# Claude Telegram Router

[English](README.md) · **Tiếng Việt**

Một bot Telegram, một group có Topics: **mỗi topic là một dự án**. Nhắn trong topic nào thì Claude Code làm việc trong thư mục của dự án đó và trả lời ngay trong topic đó. Không cần @bot, không cần mở terminal cho từng dự án.

## Cần có

- [Bun](https://bun.sh) ≥ 1.3
- [Claude Code](https://docs.claude.com/en/docs/claude-code) đã cài và đăng nhập (`claude` chạy được trong terminal)
- Một tài khoản Telegram và một bot mới tạo bằng @BotFather
- Windows 10/11 (đã chạy thật và có test). macOS / Linux: mã có xử lý, nhưng chưa chạy thử; khởi động bằng `bun run start`.

## Cách hoạt động

- Mỗi topic có **một tiến trình Claude chạy sẵn** trong thư mục đã gắn. Tin đầu tiên khởi động nó (vài giây); các tin sau đi thẳng vào tiến trình đó nên trả lời nhanh hơn. Nội dung tin được đưa vào qua stdin, không nằm trên dòng lệnh.
- Tiến trình sống đến khi gõ `/stop`, `/new`, `/bind`, `/unbind` hoặc đóng bot; mỗi topic đang chạy sẵn tốn khoảng 150–180 MB RAM. Tắt rồi thì tin sau mở lại và vẫn nhớ ngữ cảnh (`--resume`).
- **Nhắn thêm khi Claude đang làm**: bot trả lời "📨 Đã gửi vào việc đang chạy". Claude đọc tin ở bước kế tiếp; lúc đó tin "📨" đổi thành "Claude đã đọc tin này". Câu đầu tiên Claude viết sau khi đọc được gửi ngay thành tin trả lời cho tin đó, không đợi xong cả việc. Claude được dặn không ngồi chờ bằng vòng lặp `sleep` mà chạy việc lâu ở nền, để tin mới vào được.
- **Claude tự làm tiếp**: khi một việc Claude để chạy nền (bot, test, agent, theo dõi log) xong, Claude tự làm bước tiếp theo. Bot mở tin "🔔 Claude tự làm tiếp" có tiến độ như thường và gửi câu trả lời vào topic. Nhắn trong lúc đó thì tin được gộp vào việc đang chạy.
- Mỗi topic giữ phiên Claude riêng: tin sau nhớ ngữ cảnh tin trước, cho đến khi gõ `/new`.
- Sau mỗi tin, dòng "✅ Xong" cho biết ngữ cảnh của phiên đang lớn cỡ nào (ví dụ `🧠 210k`). Khi phiên vượt `CONTEXT_WARN_TOKENS` token (mặc định 200k) hoặc `SESSION_WARN_MESSAGES` tin (mặc định 20), bot gửi một tin cảnh báo trong topic, một lần, kèm `/new` bấm được. Phiên càng lớn thì mỗi tin càng chậm và tốn, vì Claude phải đọc lại toàn bộ ngữ cảnh.
- Toàn bot có tối đa `MAX_PARALLEL_RUNS` topic cùng làm việc (mặc định 3); topic thứ tư chờ đến lượt. Topic đang chạy sẵn mà rảnh thì không tính. Lượt Claude tự làm tiếp cũng không tính: Claude đã chạy rồi, không giữ lại được.
- Trong lúc chạy, bot sửa một tin "⏳ đang làm…" để hiện các bước gần nhất. Xong thì gửi câu trả lời; câu trả lời quá dài được gửi thành tệp `ket-qua.txt`.
- Ảnh và tệp gửi kèm được lưu vào `data/inbox/` (tự xoá sau 7 ngày), đường dẫn được đưa cho Claude đọc.
- **Claude gửi ảnh / tệp**: bảo Claude "gửi ảnh…" là đủ. Claude viết một dòng `📎 <đường dẫn>` (có thể thêm ` | chú thích`), bot gửi tệp đó vào đúng topic: ảnh (png, jpg, webp đến 10 MB) hiện dạng ảnh, tệp khác dạng tệp (đến 50 MB). Dòng `📎` nằm trong khối code ``` chỉ là ví dụ, bot không gửi. Bot không bao giờ gửi tệp bí mật (`.env`, khoá SSH, `.pem`, `~/.claude/channels`). Claude được dặn không tự gọi API Telegram hay dùng token của bot khác, vì làm vậy tin sẽ rơi vào chat khác.
- **Claude chạy với `--dangerously-skip-permissions`**: không hỏi trước khi chạy lệnh hay sửa tệp. Vì vậy chỉ người có ID trong `ALLOWED_USER_IDS` mới ra lệnh được, và chỉ trong group có ID trong `ALLOWED_CHAT_IDS`.

## Cài đặt (một lần)

1. **Tạo bot mới** với @BotFather (`/newbot`). Đừng dùng lại bot của plugin Telegram: mỗi bot chỉ một chương trình nhận tin được (lỗi 409).
2. **Tắt privacy mode** để bot đọc được mọi tin trong group: @BotFather → `/setprivacy` → chọn bot → **Disable**. (Hoặc đặt bot làm admin của group.)
3. **Tạo group** → Edit → bật **Topics** → tạo các topic, mỗi topic một dự án. Thêm bot vào group *sau* bước 2. Nếu bot đã ở trong group từ trước, xoá ra rồi thêm lại.
4. **Điền `.env`** (chép từ `.env.example`):
   - `TELEGRAM_BOT_TOKEN`: token từ @BotFather.
   - `ALLOWED_USER_IDS`: ID Telegram của bạn.
   - `ALLOWED_CHAT_IDS`: để trống lúc đầu.
5. **Chạy** `start-router.cmd`. Nhắn bất kỳ tin nào trong group: bot trả lời ID của group (dạng `-100…`). Điền ID đó vào `ALLOWED_CHAT_IDS`, đóng cửa sổ rồi chạy lại.
6. **Gắn dự án**: trong mỗi topic gõ một lần, ví dụ `/bind D:\nodejs\sky-farm`.

## Hướng dẫn dùng

Sau khi gắn, cứ nhắn trong topic như nhắn cho một lập trình viên đang ngồi trong thư mục dự án:

```
Bạn:    Chạy test rồi sửa các test đang lỗi
Bot:    ⏳ đang làm… (hiện các bước gần nhất: Read, Bash, Edit…)
Bot:    Đã sửa 2 test trong tests/api.test.ts …
        ✅ Xong · 🧠 64k
```

Các tình huống hay gặp:

| Bạn muốn | Làm thế này |
| --- | --- |
| Giao việc | Nhắn bình thường: "thêm nút đăng xuất vào header" |
| Bổ sung giữa chừng | Nhắn tiếp, không cần đợi. Bot báo "📨 Đã gửi vào việc đang chạy", Claude đọc ở bước kế tiếp |
| Gửi ảnh lỗi / thiết kế | Gửi ảnh (hoặc album, tệp) kèm chú thích "giao diện bị vỡ như ảnh này, sửa giúp" |
| Nhận ảnh / tệp | "chụp màn hình trang chủ rồi gửi tôi", "gửi file báo cáo vừa tạo" |
| Đổi model | `/model` rồi bấm nút, hoặc `/model opus` |
| Cài skill cho dự án | `/skills`, chọn nguồn, bấm skill (bấm lại để gỡ) |
| Bắt đầu chủ đề mới | `/new` (phiên quá dài làm mỗi tin chậm và tốn hơn; bot sẽ nhắc) |
| Dừng ngay | `/stop` |
| Xem đang làm gì | `/status` |
| Làm nhiều dự án | Mỗi dự án một topic; tối đa `MAX_PARALLEL_RUNS` topic chạy cùng lúc |
| Quản lý / chuyển server (không có dự án) | Gắn một thư mục trống, gõ `/server` rồi bấm nút, xem ví dụ dưới |

### Ví dụ: topic `server` để chuyển server A sang server B

Mọi bước làm trên Telegram:

1. Tạo topic `server`, gắn một thư mục trống bất kỳ: `/bind D:\servers`.
2. Gõ `/server`, bấm **⚙️ Server A**. Bot hỏi lần lượt, mỗi câu bạn gửi một tin:
   ```
   Bot: Bước 1/4: gửi host (IP hoặc tên miền)   Bạn: 1.2.3.4
   Bot: Bước 2/4: gửi port SSH (thường là 22)    Bạn: 22
   Bot: Bước 3/4: gửi tên đăng nhập              Bạn: root
   Bot: Bước 4/4: gửi mật khẩu                   Bạn: ********
   Bot: ✅ Đã lưu server A: root@1.2.3.4:22
   ```
   Làm tương tự với **⚙️ Server B**. Các câu trả lời không được chuyển cho Claude; gõ lệnh bất kỳ giữa chừng là huỷ. Muốn nhanh thì gõ một dòng: `/server a root@1.2.3.4:22 mật-khẩu`.

   Bot xoá ngay tin có mật khẩu (bot cần là admin có quyền "Xoá tin"; không xoá được thì bot nhắc bạn tự xoá), rồi ghi tài khoản vào `.env.servers` trong thư mục. Bot không bao giờ gửi tệp này lên Telegram. Lần đầu, bot chép thêm hai tệp mẫu trong [`templates/server-topic`](templates/server-topic) vào thư mục (không ghi đè tệp đã có):
   - `ssh-to.sh`: Claude chạy `./ssh-to.sh a 'lệnh'` để vào server. Mật khẩu đưa cho ssh qua `SSH_ASKPASS`, không nằm trên dòng lệnh (dòng lệnh hiện trong tin tiến độ trên Telegram).
   - `CLAUDE.md`: cách kết nối, quy tắc (A chỉ đọc; hỏi trước lệnh khó hoàn tác trên B; ghi `nhat-ky.md`), các việc cần chuyển. Sửa tệp này nếu việc của bạn khác.
3. Gõ `/server` để xem lại (mật khẩu được che), rồi nhắn: "kiểm kê server A rồi lập kế hoạch chuyển sang B".

Cần OpenSSH 8.4 trở lên (có sẵn trong Git for Windows). Lần đầu kết nối, host key được tự nhận.

## Lệnh

| Lệnh | Tác dụng |
| --- | --- |
| `/bind D:\đường\dẫn` | Gắn topic với thư mục dự án (phiên cũ của topic bị quên) |
| `/status` | Dự án, phiên, độ lớn ngữ cảnh, Claude đang làm / chạy sẵn / chưa mở |
| `/new` | Tin sau bắt đầu cuộc trò chuyện mới |
| `/model` | Chọn model cho topic bằng nút bấm: mọi model Claude Code có cho tài khoản (bản mới nhất và các bản cũ hơn, lấy từ Claude Code lúc bot khởi động), hoặc `/model <tên>`. Đổi ngay trong Claude đang chạy, vẫn nhớ ngữ cảnh; đang làm việc thì áp dụng khi xong |
| `/api` | Khai báo và bật tắt API riêng của topic (thay cho đăng nhập Claude của máy), làm hết trên Telegram: bấm **✏️ Điền cấu hình** rồi trả lời host, port, token (hoặc một dòng: `/api http://192.168.1.10:23334 TOKEN`). Lưu xong là tự bật và **thử kết nối** (`GET /v1/models`: kết nối được / token bị từ chối / sai port / quá thời gian…). Nút: **🟢 Bật API / 🔴 Tắt API**, **🧪 Test kết nối**, **✏️ Sửa**, **🗑️ Xoá**; gõ chữ: `/api test`, `/api on|off|clear`. Khi bật, Claude nhận `ANTHROPIC_BASE_URL` và `ANTHROPIC_AUTH_TOKEN` từ tệp `--settings` riêng của topic trong `data/topic-api/` (ưu tiên hơn `~/.claude/settings.json` và `.claude/settings*.json` của dự án; không ghi gì vào dự án). Khi tắt, nếu dự án tự đặt API riêng thì tệp đó để trống hai biến này nên Claude dùng đăng nhập của máy (API mà máy đặt qua biến môi trường cũng bị để trống theo; đăng nhập bằng `claude /login` không bị ảnh hưởng); dự án không đặt API thì bot không truyền tệp nào, cấu hình của máy giữ nguyên. Khi `ANTHROPIC_BASE_URL` của dự án bị đè, các biến model của dự án (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`…) cũng được để trống. `/api clear` thì trả lại cho cấu hình của dự án. `/disable_api` dùng được cả khi chưa lưu cấu hình nào. Khi bạn chưa chọn gì, dự án tự đặt API trong `.claude/settings*.json` vẫn dùng API đó: `/api` và `/status` cảnh báo, bảng `/api` có nút **🔴 Tắt API của dự án**. `ANTHROPIC_API_KEY` của dự án cũng bị để trống mỗi khi lựa chọn của topic đè lên. Đổi cấu hình thì Claude của topic khởi động lại (vẫn cùng phiên, khi Claude đang rảnh). Tin có token bị xoá ngay; `/status` chỉ hiện 4 ký tự cuối. Server API chuyển hướng thì bot không đi theo, nên token không bị gửi sang host khác |
| `/enable_api`, `/disable_api` | Bật API đã lưu (kèm thử kết nối) hoặc tắt. Gõ `/enable-api`, `/disable-api` cũng được, nhưng Telegram chỉ cho bấm trực tiếp vào dạng gạch dưới |
| `/skills` | Chọn skill bằng nút bấm: chọn nguồn (Ponytail, ClaudeKit), rồi bấm skill để chép vào `.claude/skills` của dự án (✓ = đã có; bấm lại để gỡ). Skill lấy từ máy: plugin ponytail đã cài, và các skill ClaudeKit trong `~/.claude/skills`. Mỗi bản chép có tệp `.router-skill.json` ghi lại các tệp đã chép; chỉ gỡ khi mọi tệp còn nguyên, nên skill riêng của dự án hoặc đã sửa không bao giờ bị ghi đè hay gỡ. Thư mục dùng chung `_shared`, `common` của ClaudeKit được chép kèm vì vài skill cần. Không chép tệp bí mật (`.env`, khoá), link và cache |
| `/server` | Xem server đã khai báo, kèm nút **⚙️ Server A** / **⚙️ Server B**: bấm thì bot hỏi từng bước (host, port, tên đăng nhập, mật khẩu). Hoặc một dòng: `/server a\|b user@host[:port] mật-khẩu`. Tài khoản được ghi vào `.env.servers` của thư mục, chép `ssh-to.sh` và `CLAUDE.md` mẫu nếu chưa có; tin có mật khẩu bị xoá ngay. Không nhận thư mục nằm trong repo git (mật khẩu có thể bị commit) |
| `/stop` | Dừng việc đang chạy và tắt tiến trình Claude của topic (cả các tiến trình nó mở). Lúc rảnh: chỉ tắt tiến trình để trả RAM |
| `/topics` | Các topic đã gắn trong group |
| `/unbind` | Bỏ gắn topic |
| `/id` | ID chat / topic / người dùng |
| `/help` | Tóm tắt ngắn các lệnh |
| `/guide` | Hướng dẫn đầy đủ từng bước cho người mới (trả lời được cả khi nhắn riêng với bot) |

Gõ `/` trong group sẽ hiện các lệnh trên; trong chat riêng với bot chỉ có `/id`, `/help` và `/guide` (bot chỉ làm việc trong group). Nếu menu "/" chưa hiện lệnh mới, bấm thẳng vào lệnh trong tin `/guide` hoặc `/help`: Telegram cho bấm các lệnh có dạng `/ten_lenh`.

## Cần biết

- Máy phải bật và cửa sổ `start-router.cmd` phải mở. Muốn bot tự chạy khi đăng nhập Windows: tạo shortcut tới `start-router.cmd` trong thư mục `shell:startup`.
- Tin đầu tiên (hoặc tin đầu sau `/stop`, `/new`, khởi động lại bot) phải mở Claude nên chậm hơn vài giây; các tin sau thì không.
- Khi cần bạn quyết định, Claude dừng lại và hỏi trong câu trả lời. Bạn trả lời trong topic là tiếp tục. Nhắn thêm giữa chừng thì Claude đọc ở bước kế tiếp.
- Tin gửi lúc bot tắt quá `STALE_MESSAGE_MINUTES` phút (mặc định 10) bị bỏ qua, để bot không tự chạy những việc cũ khi bật lại.
- Một việc chạy quá `RUN_TIMEOUT_MINUTES` phút (mặc định 60) bị dừng.
- Trạng thái (topic → thư mục, phiên) nằm trong `data/state.json`.
- Bot tự tìm `claude.exe` theo PATH (bản cài npm global, kể cả tệp gốc trong gói `claude-code-win32-x64`, rồi `~/.local/bin`). Bot tìm lại mỗi lần mở Claude, nên không cần khởi động lại khi Claude Code tự cập nhật (lúc thay bản mới, nó đổi tên `claude.exe` hoặc tạm dời cả gói đi). Tệp nhỏ hơn 4 KB là tệp giữ chỗ của npm, không được dùng. Đặt `CLAUDE_BIN` trong `.env` thì bot chỉ dùng đúng tệp đó.
- Máy có nhiều bản Node (ví dụ Node của laragon và Node cài sẵn) thì cho npm của chúng cài global vào cùng một chỗ (`npm config set prefix "%APPDATA%\npm"`). Nếu không, bản cập nhật Claude Code có thể rơi vào thư mục khác với thư mục bot và lệnh `claude` đang dùng.
- Chỉ chạy được **một** router cùng lúc (khoá `data/router.lock`). Nếu bot báo đang chạy ở tiến trình khác mà bạn chắc là không, xoá file đó.
- Mỗi thư mục chỉ gắn với một topic, để hai phiên Claude không cùng sửa một chỗ.
- Trong các lần router chạy Claude, plugin Telegram của Claude Code (nếu bạn có cài) bị tắt: nếu không, nó sẽ giành tin của bot plugin. Plugin vẫn chạy bình thường trong các phiên terminal của bạn.
- Đóng cửa sổ bot (hoặc Ctrl+C) thì mọi tiến trình Claude (đang làm hay đang chạy sẵn) và các tiến trình chúng mở cũng bị dừng.
- Tin chuyển tiếp được đánh dấu cho Claude biết là lời người khác, chỉ để tham khảo.

## Phát triển

```
bun install
bun run typecheck
bun run test
```

Test dùng `tests/fixtures/fake-claude.ts` thay cho `claude.exe`, nên không tốn lượt Claude.

## Giấy phép

[MIT](LICENSE)
