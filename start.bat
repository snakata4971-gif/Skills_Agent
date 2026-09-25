@echo off
chcp 65001 >nul
rem QA Skill Builder をダブルクリックで起動します（Windows 用）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。https://nodejs.org/ から Node.js 22 以上をインストールしてください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 初回のため、必要な部品をインストールしています…
  call npm install
  if errorlevel 1 (
    echo インストールに失敗しました。
    pause
    exit /b 1
  )
)

start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
echo QA Skill Builder を起動します。止めるときはこのウィンドウで Ctrl + C を押してください。
call npm start
