/**
 * INSPECTOR — run against the attached Chrome tab on the video generation
 * page to dump the real toolbar structure. Paste the output back so the
 * upload-icon selector in step3_video_automation.js can be locked in exactly
 * instead of relying on structural guessing.
 *
 * Usage: node inspect_video_page.js
 */

const { attachToChrome } = require('./lib/attach');

const TARGET_URL_PATTERN = /leonardo\.ai|jintools\.com|testingg\.in/;
const FALLBACK_URL =
  'https://leonardo2.testingg.in/generate?model=wan-2.6&aspectRatio=16:9&size=RESOLUTION_720&duration=15&seedEnabled=false&negativePromptEnabled=false';

async function describeButton(page, btn, index) {
  const tag = await btn.evaluate((n) => n.tagName).catch(() => '?');
  const cls = await btn.getAttribute('class').catch(() => null);
  const ariaLabel = await btn.getAttribute('aria-label').catch(() => null);
  const title = await btn.getAttribute('title').catch(() => null);
  const text = (await btn.innerText().catch(() => '')).slice(0, 40).replace(/\n/g, ' ');
  const visible = await btn.isVisible().catch(() => false);
  const html = await btn.evaluate((n) => n.outerHTML.slice(0, 200)).catch(() => '');
  console.log(
    `  [${index}] <${tag}> visible=${visible} aria-label="${ariaLabel}" title="${title}" class="${cls}" text="${text}"\n      html: ${html}`
  );
}

async function main() {
  console.log('Attaching to running Chrome session...');
  const { page } = await attachToChrome({ urlPattern: TARGET_URL_PATTERN, fallbackUrl: FALLBACK_URL });
  console.log(`Attached. Active URL: ${page.url()}`);

  const promptCandidates = ['textarea[placeholder*="prompt" i]', 'input[placeholder*="prompt" i]', 'div[contenteditable="true"]', 'textarea'];
  let promptInput = null;
  for (const sel of promptCandidates) {
    const el = page.locator(sel).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) {
      promptInput = el;
      console.log(`\nPrompt input found via selector: "${sel}"`);
      break;
    }
  }

  if (!promptInput) {
    console.log('\nNo prompt input found with the candidate selectors — dumping all textareas/contenteditable on the page instead.');
    const all = page.locator('textarea, [contenteditable="true"], input');
    const count = await all.count();
    console.log(`Found ${count} candidates:`);
    for (let i = 0; i < Math.min(count, 10); i++) {
      await describeButton(page, all.nth(i), i);
    }
    return;
  }

  const toolbar = promptInput
    .locator('xpath=ancestor::div[.//button[contains(translate(text(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"generate")]][1]')
    .first();

  if (!(await toolbar.count())) {
    console.log('\nCould not find a toolbar ancestor containing a "Generate" button. Dumping all buttons on the page instead.');
    const allButtons = page.locator('button');
    const count = await allButtons.count();
    console.log(`Found ${count} buttons on the page (showing first 20):`);
    for (let i = 0; i < Math.min(count, 20); i++) {
      await describeButton(page, allButtons.nth(i), i);
    }
    return;
  }

  console.log('\n--- Buttons inside the prompt toolbar (same row as prompt input + Generate) ---');
  const buttons = toolbar.locator('button');
  const count = await buttons.count();
  console.log(`Found ${count} button(s):`);
  for (let i = 0; i < count; i++) {
    await describeButton(page, buttons.nth(i), i);
  }

  console.log('\nDone. Paste this whole output back so the upload-icon selector can be pinned down exactly.');
}

main().catch((err) => {
  console.error('Inspector error:', err);
  process.exit(1);
});