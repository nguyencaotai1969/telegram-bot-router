# Topic server: quản lý và chuyển server

Thư mục này không phải dự án code. Đây là chỗ làm việc của topic "server": Claude điều khiển server A và B qua SSH, đăng nhập bằng tài khoản (user + mật khẩu).

## Kết nối

Tài khoản của 2 server nằm trong `.env.servers` cạnh tệp này (`SERVER_A_*`, `SERVER_B_*`), do bot ghi khi tôi gõ `/server` trên Telegram. Luôn kết nối qua `ssh-to.sh`, chạy bằng Bash:

```sh
./ssh-to.sh a 'uname -a; df -h'          # chạy lệnh trên server A
./ssh-to.sh b 'systemctl status nginx'   # chạy lệnh trên server B
./ssh-to.sh b 'bash -s' < buoc-1.sh      # chạy một script nhiều bước
./ssh-to.sh a 'tar czf - -C /var/www .' | ./ssh-to.sh b 'mkdir -p /var/www && tar xzf - -C /var/www'   # chép A → B
```

- Không gọi `ssh user@host` trực tiếp, không đưa mật khẩu lên dòng lệnh: dòng lệnh hiện trong tin tiến độ trên Telegram.
- Không đọc, không in, không chép nội dung `.env.servers` vào câu trả lời hay nhật ký.
- Không có shell tương tác: mỗi lần gọi là một lệnh. Nối nhiều bước bằng `&&`, hoặc gửi script qua stdin như trên.
- Chưa có tài khoản hoặc đăng nhập lỗi: nhắc tôi gõ `/server` trong topic rồi bấm nút server cần khai báo, đừng đoán mật khẩu.

## Server

| Tên | Vai trò |
| --- | --- |
| A | Server cũ, đang chạy thật |
| B | Server mới, đích chuyển sang |

## Quy tắc

- Server A chỉ đọc và sao lưu: không xoá, không dừng dịch vụ, không sửa cấu hình khi tôi chưa đồng ý.
- Trước mọi lệnh khó hoàn tác trên B (xoá, ghi đè database, đổi firewall, đổi DNS): dừng lại và hỏi tôi.
- Chạy việc lâu (chép dữ liệu, dump database) ở nền và theo dõi log, không ngồi chờ.
- Ghi từng bước đã làm vào `nhat-ky.md` trong thư mục này: lệnh, kết quả, việc còn lại.

## Việc cần chuyển (A → B)

- [ ] Kiểm kê server A: OS, dịch vụ đang chạy, port, dung lượng đĩa
- [ ] Cài môi trường trên B giống A (runtime, nginx, database...)
- [ ] Mã nguồn và tệp upload/static
- [ ] Database: dump trên A, nạp vào B, so số bản ghi
- [ ] Cấu hình nginx, SSL
- [ ] Cron, service (systemd / pm2)
- [ ] Chạy thử trên B (qua IP hoặc sửa hosts) trước khi đổi DNS
- [ ] Đổi DNS, theo dõi lỗi, giữ A thêm vài ngày rồi mới tắt
