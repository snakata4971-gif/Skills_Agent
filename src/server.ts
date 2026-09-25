import { aiMode } from "./ai/client.ts";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { getSettings } from "./settings.ts";
import { log } from "./util.ts";
import { closeBrowser } from "./wms/browserAdapter.ts";

const server = createApp().listen(config.port, () => {
  const s = getSettings();
  log("server", `QA Skill Builder を起動しました → http://localhost:${config.port}`);
  log("server", `AI: ${aiMode() === "live" ? `接続（${s.model} / effort ${s.effort}）` : "未接続（デモモード。.env に ANTHROPIC_API_KEY を設定すると有効）"}`);
  log("server", `WMS連携: ${s.wms_mode === "browser" ? "ブラウザ自動操作" : "API"}（${config.wms.baseUrl}）`);
  log("server", `模擬WMS → http://localhost:${config.port}/wms/`);
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    log("server", `ポート ${config.port} は使用中です。すでに起動していないか確認するか、.env の PORT を変更してください`);
    process.exit(1);
  }
  throw e;
});

async function shutdown() {
  log("server", "終了します");
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
