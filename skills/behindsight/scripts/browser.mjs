// The one place that starts the browser, so a missing download gives an instruction instead of a stack trace.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { chromium };

const SETUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'setup.sh');

// Playwright keeps its browsers in a shared cache, and installing another Playwright version
// elsewhere can remove the one this skill needs.
export async function launchBrowser(options = {}) {
  try {
    return await chromium.launch(options);
  } catch (e) {
    if (!/Executable doesn't exist|playwright install/i.test(e.message || '')) throw e;
    console.error(`Playwright's Chromium browser isn't installed, or an update removed it. Run setup again: sh ${SETUP}`);
    process.exit(3);
  }
}
