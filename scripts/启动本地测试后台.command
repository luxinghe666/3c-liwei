#!/bin/zsh
# Run manually on the Mac. Uses the existing local database; never resets it.
set -u
cd "$(dirname "$0")/.." || exit 1

runtime_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [ -x "$runtime_node" ]; then
  finance_node="$runtime_node"
elif command -v node >/dev/null 2>&1; then
  finance_node="$(command -v node)"
else
  print '未找到 Node.js。请安装 Node.js 24.13 或更新的 24 LTS 版本后重试。'
  read '?按回车关闭窗口。'
  exit 1
fi

if ! "$finance_node" --input-type=module -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>24||(major===24&&minor>=13)?0:1)'; then
  print '当前 Node.js 版本过低，需要 24.13 或更新版本。'
  read '?按回车关闭窗口。'
  exit 1
fi

# Keep the local test address consistent with the iPhone Debug configuration.
export HOST=127.0.0.1
export PORT=4318
export APP_ORIGIN=http://127.0.0.1:4318
export DB_PATH="$PWD/data/finance.sqlite"
print '原拓财务 · 本机测试后台'
print '请保持此终端窗口打开。停止后台请按 Control+C。'
print '浏览器打开 http://127.0.0.1:4318/ ，首次创建老板测试账号。'
print '然后在 iPhone 模拟器使用同一账号登录。'
print '此脚本使用现有账本，不会清空已有数据。'

if ! "$finance_node" server/start.mjs; then
  print '后台未成功启动。若提示 EADDRINUSE，端口可能已被一个后台占用，请先访问上方地址确认。'
  read '?请保留错误信息，按回车关闭窗口。'
  exit 1
fi
