// AUTO-GENERATED — do not edit by hand.
// Run `bun run scripts/build-admin-embedded.ts` to regenerate.
// Source: admin/dist/ content sha256 bba875c4300f274348a41d66f52c8fc80bfa5e7eb7e0f661e2d60a43d6f76f7e.
//
// Bun resolves the file: imports to a path that works at runtime even
// inside a compiled binary (`bun build --compile`). The manifest maps
// the request path the express handler sees to (resolved-path, mime).

// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_0_assets_index_Bus__4A0_css from '../admin/dist/assets/index-Bus__4A0.css' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_1_assets_index_D78kE_vQ_js from '../admin/dist/assets/index-D78kE_vQ.js' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_2_assets_voltage_logo_v_Bdo37kTM_png from '../admin/dist/assets/voltage-logo-v-Bdo37kTM.png' with { type: 'file' };
// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts
import A_3_index_html from '../admin/dist/index.html' with { type: 'file' };

export interface AdminAsset {
  path: string;
  mime: string;
}

export const ADMIN_ASSETS: Record<string, AdminAsset> = {
  "/admin/assets/index-Bus__4A0.css": { path: A_0_assets_index_Bus__4A0_css as unknown as string, mime: "text/css; charset=utf-8" },
  "/admin/assets/index-D78kE_vQ.js": { path: A_1_assets_index_D78kE_vQ_js as unknown as string, mime: "application/javascript; charset=utf-8" },
  "/admin/assets/voltage-logo-v-Bdo37kTM.png": { path: A_2_assets_voltage_logo_v_Bdo37kTM_png as unknown as string, mime: "image/png" },
  "/admin/index.html": { path: A_3_index_html as unknown as string, mime: "text/html; charset=utf-8" },
};

/** Index entry point for SPA fallback. */
export const ADMIN_INDEX_HTML: AdminAsset = ADMIN_ASSETS['/admin/index.html'];

export const ADMIN_ASSET_COUNT = 4;
export const ADMIN_CONTENT_SHA256 = "bba875c4300f274348a41d66f52c8fc80bfa5e7eb7e0f661e2d60a43d6f76f7e";
