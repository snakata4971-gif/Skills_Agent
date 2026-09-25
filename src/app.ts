import express from "express";
import { config } from "./config.ts";
import { apiRouter } from "./routes/api.ts";
import { replyRouter } from "./routes/reply.ts";
import { seedAll } from "./seed/seed.ts";
import { mockWmsRouter } from "./wms/mock/router.ts";

/** Builds the web app (inspection app, customer reply page and the bundled mock WMS). */
export function createApp() {
  seedAll();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use("/wms", mockWmsRouter());
  app.use("/api", express.json({ limit: "5mb" }), apiRouter());
  app.use("/reply", replyRouter());
  app.use("/files", express.static(config.paths.uploads, { fallthrough: false, maxAge: "1h" }));
  app.use(express.static(config.paths.public, { extensions: ["html"] }));
  return app;
}
