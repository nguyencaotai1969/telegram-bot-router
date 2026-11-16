#!/bin/sh
# Chạy lệnh trên server A hoặc B, đăng nhập bằng tài khoản trong .env.servers cạnh tệp này
# (bot ghi tệp đó khi gõ /server trong topic).
# Dùng: ./ssh-to.sh a|b 'lệnh'
# Mật khẩu đi qua SSH_ASKPASS (ssh gọi lại chính tệp này): không nằm trên dòng lệnh, không chiếm stdin.

# Vai trò SSH_ASKPASS: ssh hỏi mật khẩu thì in ra.
if [ -n "$SSH_TO_PASSWORD" ]; then printf '%s\n' "$SSH_TO_PASSWORD"; exit 0; fi

dir=$(cd "$(dirname "$0")" && pwd)
case "$1" in
  a|A) name=A ;;
  b|B) name=B ;;
  *) echo "Dùng: $0 a|b 'lệnh'" >&2; exit 2 ;;
esac
shift
env_file="$dir/.env.servers"
prefix=SERVER_$name

# Đọc thô KEY=giá trị, không source: mật khẩu có $ ` " ' vẫn giữ nguyên. tr bỏ \r của tệp sửa bằng Notepad.
env_value() { sed -n "s/^$1=//p" "$env_file" 2>/dev/null | head -n 1 | tr -d '\r'; }
host=$(env_value "${prefix}_HOST")
port=$(env_value "${prefix}_PORT")
user=$(env_value "${prefix}_USER")
SSH_TO_PASSWORD=$(env_value "${prefix}_PASSWORD")
if [ -z "$host" ] || [ -z "$user" ] || [ -z "$SSH_TO_PASSWORD" ]; then
  echo "Chưa có tài khoản server $name: gõ /server trong topic Telegram để khai báo" >&2
  exit 2
fi

export SSH_TO_PASSWORD SSH_ASKPASS="$dir/ssh-to.sh" SSH_ASKPASS_REQUIRE=force
exec ssh -p "${port:-22}" -o StrictHostKeyChecking=accept-new -o NumberOfPasswordPrompts=1 "$user@$host" "$@"
