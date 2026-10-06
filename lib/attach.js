/**
 * Shared helper for connecting Playwright to a Chrome window YOU launched
 * by hand (via windows/launch-chrome.bat), instead of Playwright launching
 * its own Chrome. This avoids Chrome's restriction on remote-debugging the
 * default profile directory, and lets you keep using your real profile +
 * extension, already logged in, exactly as you left it.
 */

const { chromium } = require('playwright');

const CDP_ENDPOINT = 'http://localhost:9222';

/**
 * Scans all pages in all contexts of an already-connected browser for one
 * whose URL matches urlPattern. Retries a few times in case the tab isn't
 * open yet when the script starts.
 */
async function findTargetPage(browser, urlPattern, { retries = 5, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (urlPattern.test(page.url())) {
          return { context, page };
        }
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/**
 * Connects to the Chrome instance started with --remote-debugging-port=9222
 * and returns { browser, context, page } for the tab matching urlPattern.
 * If no matching tab is found, opens a new tab in the first available
 * context and navigates to fallbackUrl instead.
 */
async function attachToChrome({ urlPattern, fallbackUrl }) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  } catch (err) {
    throw new Error(
      `Could not connect to Chrome at ${CDP_ENDPOINT}. Is Chrome running via ` +
      `windows/launch-chrome.bat? Original error: ${err.message}`
    );
  }

  let found = await findTargetPage(browser, urlPattern);

  if (!found) {
    console.log(`No open tab matching ${urlPattern} found — opening a new tab at ${fallbackUrl}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(
        'Connected to Chrome, but no browser context was found. Make sure Chrome ' +
        'launched successfully with launch-chrome.bat (check the window actually opened).'
      );
    }
    const page = await context.newPage();
    await page.goto(fallbackUrl);
    found = { context, page };
  }

  return { browser, context: found.context, page: found.page };
}

/**
 * Attaches a response handler to every current page in a context AND any
 * page opened later (e.g. if Leonardo opens a generation in a new tab).
 * Returns a cleanup function to remove all listeners.
 */
function watchAllResponses(context, handler) {
  const attached = new Set();

  function attach(page) {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('response', handler);
  }

  context.pages().forEach(attach);
  context.on('page', attach);

  return function cleanup() {
    context.off('page', attach);
    attached.forEach((p) => p.off('response', handler));
  };
}

module.exports = { attachToChrome, watchAllResponses, CDP_ENDPOINT };
