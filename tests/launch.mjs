// Shared browser launcher for the Playwright test scripts.
// Defaults: a REAL, non-headless, MAXIMIZED window. On a Wayland desktop it
// runs as a NATIVE Wayland client (no Xwayland); on a headless host (Xvfb / X11)
// it falls back to the default X11 backend.
import { chromium } from 'playwright';

export async function launchBrowser() {
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'];
  if (process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland'); // native Wayland, not Xwayland
  const opts = { headless: false, args };
  if (process.env.CHROMIUM_BIN) opts.executablePath = process.env.CHROMIUM_BIN;
  return chromium.launch(opts);
}

// viewport:null lets the maximized OS window drive the page size.
export const CONTEXT = { viewport: null };
