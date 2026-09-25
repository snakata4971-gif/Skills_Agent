#!/bin/bash
# QA Skill Builder をダブルクリックで起動します（Mac 用）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org/ から Node.js 22 以上をインストールしてください。"
  read -r -p "Enter キーで閉じます"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "初回のため、必要な部品をインストールしています…"
  npm install || { read -r -p "インストールに失敗しました。Enter キーで閉じます"; exit 1; }
fi

(sleep 4 && open "http://localhost:${PORT:-3000}") &
echo "QA Skill Builder を起動します。止めるときはこのウィンドウで Ctrl + C を押してください。"
npm start
