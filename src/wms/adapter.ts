import { getSettings } from "../settings.ts";
import { ApiWmsAdapter } from "./apiAdapter.ts";
import { BrowserWmsAdapter } from "./browserAdapter.ts";
import type { WmsAdapter } from "./types.ts";

/** The WMS connection chosen in settings: the API, or browser automation when no API exists. */
export function getWms(): WmsAdapter {
  return getSettings().wms_mode === "browser" ? new BrowserWmsAdapter() : new ApiWmsAdapter();
}
