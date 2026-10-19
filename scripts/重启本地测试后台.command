#!/bin/zsh
# Run manually. Stop only this project's Node server on its documented local port.
set -eu
cd "$(dirname "$0")/.."
finance_project="$PWD"
finance_pids=($(/usr/sbin/lsof -nP -t -iTCP:4318 -sTCP:LISTEN 2>/dev/null || true))
for finance_pid in "${finance_pids[@]}"; do
  finance_cwd=$(/usr/sbin/lsof -a -p "$finance_pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p')
  finance_args=$(/bin/ps -p "$finance_pid" -o command=)
  if [[ "$finance_cwd" != "$finance_project" || "$finance_args" != *node*server/start.mjs* ]]; then
    print "端口 4318 被其他程序占用，未停止该程序（PID $finance_pid）。"
    read '?按回车关闭。'
    exit 1
  fi
done
for finance_pid in "${finance_pids[@]}"; do
  print "正在停止原拓财务旧后台（PID $finance_pid）…"
  /bin/kill -TERM "$finance_pid"
done
for finance_attempt in {1..30}; do
  if ! /usr/sbin/lsof -nP -t -iTCP:4318 -sTCP:LISTEN >/dev/null 2>&1; then
    exec /bin/zsh "$finance_project/scripts/启动本地测试后台.command"
  fi
  /bin/sleep 0.2
done
print '旧后台尚未停止，请保留窗口检查。没有强制结束进程，也没有修改账本。'
read '?按回车关闭。'
