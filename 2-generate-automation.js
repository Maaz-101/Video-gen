/**
 * STEP 2: MAIN AUTOMATION (LEONARDO2 LUCID-ORIGIN ULTRA PIPELINE)
 */

const path = require('path');
const fs = require('fs');
const { attachToChrome, watchAllResponses } = require('./lib/attach');

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const FALLBACK_URL =
  'https://leonardo2.testingg.in/generate?model=lucid-origin&aspectRatio=16:9&size=SMALL&style=111dc692-d470-4eec-b791-3475abac4c46&mode=ULTRA&quantity=1&seedEnabled=false&negativePromptEnabled=false&promptEnhance=AUTO';

const TARGET_URL_PATTERN = /leonardo2\.testingg\.in|leonardo\.ai|jintools\.com/;

const PROMPTS_FILE = path.join(__dirname, 'prompts.json');
const RESULTS_FILE = path.join(__dirname, 'results.json');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

const GENERATION_TIMEOUT_MS = 3.5 * 60 * 1000; // 3.5 min max wait per Ultra prompt
const QUEUE_RETRY_DELAY_MS = 10 * 1000;        // 10 sec retry delay

// ---------------------------------------------------------------------
// SELECTORS
// ---------------------------------------------------------------------
const PROMPT_INPUT_SELECTORS = [
  'textarea[placeholder*="prompt" i]',
  'textarea[aria-label*="prompt" i]',
  'textarea.input-element',
  'div[contenteditable="true"]',
  'textarea',
];

const GENERATE_BUTTON_SELECTORS = [
  'button:has-text("Generate")',
  'button[aria-label*="Generate" i]',
  'button:has(span:has-text("Generate"))',
  'button[type="submit"]',
  'button.generate-btn',
];

const BLOCKING_ERROR_PATTERNS = [
  /pending generations? limit/i,
  /queue.*full/i,
  /try again/i,
  /generation failed/i,
];

const ERROR_TOAST_SELECTORS = [
  '[class*="toast"]',
  '[role="alert"]',
  'div:has-text("limit")',
  'div:has-text("Pending")',
  'div:has-text("failed")',
];

const GRAPHQL_URL_PATTERN = /(\/v1\/graphql|\/api\/graphql|graphql)/i;

// ---------------------------------------------------------------------
// FILE HELPERS
// ---------------------------------------------------------------------
function loadPrompts() {
  const fileToLoad = fs.existsSync(PROMPTS_FILE)
    ? PROMPTS_FILE
    : path.join(__dirname, 'prompts.example.json');
  const raw = JSON.parse(fs.readFileSync(fileToLoad, 'utf-8'));
  const pad = String(raw.length).length < 2 ? 2 : String(raw.length).length;
  return raw.map((p, i) => {
    const fallbackId = `scene_${String(i + 1).padStart(pad, '0')}`;
    if (typeof p === 'string') return { id: fallbackId, prompt: p };
    return { id: p.id ? String(p.id) : fallbackId, prompt: p.prompt };
  });
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveResults(results) {
  const tmp = `${RESULTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(results, null, 2));
  fs.renameSync(tmp, RESULTS_FILE);
}

// ---------------------------------------------------------------------
// PAGE & NETWORK HELPERS
// ---------------------------------------------------------------------
async function findSelector(page, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) return sel;
  }
  return null;
}

async function checkForBlockingToast(page) {
  for (const sel of ERROR_TOAST_SELECTORS) {
    const el = page.locator(sel).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) {
      const text = (await el.innerText().catch(() => '')).trim();
      // Ignore routine token counter notifications
      if (text.includes('out of tokens') || text.includes('monthly fast tokens')) {
        continue;
      }
      if (text && BLOCKING_ERROR_PATTERNS.some((re) => re.test(text))) {
        return text;
      }
    }
  }
  return null;
}

function extractGenerationIdFromResponse(json) {
  if (!json) return null;
  if (json.data?.generate?.generationId) return json.data.generate.generationId;
  if (json.data?.sdGenerationJob?.generationId) return json.data.sdGenerationJob.generationId;
  if (json.data?.insert_generations_one?.id) return json.data.insert_generations_one.id;
  if (json.generationId) return json.generationId;
  if (json.id && typeof json.id === 'string' && json.id.length > 15) return json.id;
  return null;
}

async function getExistingImageUrls(page) {
  return await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    return imgs
      .map((i) => i.src)
      .filter(
        (s) =>
          s &&
          (s.includes('http') || s.startsWith('blob:')) &&
          !s.includes('thumb') &&
          !s.includes('avatar')
      );
  });
}

/**
 * Submits prompt with network interception & fallback DOM diffing
 */
async function submitPrompt(page, context, promptText) {
  const inputSel = await findSelector(page, PROMPT_INPUT_SELECTORS);
  if (!inputSel) throw new Error('Could not find prompt input box.');

  const input = page.locator(inputSel).first();
  await input.click();
  await input.fill('');
  await input.fill(promptText);

  await input.dispatchEvent('input');
  await input.dispatchEvent('change');

  const buttonSel = await findSelector(page, GENERATE_BUTTON_SELECTORS);
  if (!buttonSel) throw new Error('Could not find Generate button.');

  const button = page.locator(buttonSel).first();
  if (!(await button.isEnabled())) {
    const err = new Error('Generate button disabled (queue busy or pending job).');
    err.retriable = true;
    throw err;
  }

  let capturedGenId = null;
  const stopWatching = watchAllResponses(context, async (response) => {
    if (!GRAPHQL_URL_PATTERN.test(response.url())) return;
    try {
      const json = await response.json();
      const genId = extractGenerationIdFromResponse(json);
      if (genId) capturedGenId = genId;
    } catch { }
  });

  await button.click();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !capturedGenId) {
    await page.waitForTimeout(500);
    const blockedMsg = await checkForBlockingToast(page);
    if (blockedMsg) {
      stopWatching();
      const err = new Error(`Submission rejected: "${blockedMsg}"`);
      err.retriable = true;
      throw err;
    }
  }

  stopWatching();
  return capturedGenId;
}

/**
 * Waits for image render using Generation ID or differential URL comparison
 */
async function waitForNewImages(page, context, targetGenId, baselineUrls, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const foundUrls = new Set();

  const stopWatching = watchAllResponses(context, async (response) => {
    const url = response.url();
    const isImage =
      url.includes('.png') ||
      url.includes('.jpg') ||
      url.includes('.jpeg') ||
      url.includes('.webp');
    if (!isImage || url.includes('thumb') || url.includes('avatar') || url.includes('profile'))
      return;

    if (targetGenId && url.includes(targetGenId)) {
      foundUrls.add(url);
    } else if (!targetGenId && !baselineUrls.includes(url)) {
      foundUrls.add(url);
    }
  });

  while (Date.now() < deadline) {
    const blockedMsg = await checkForBlockingToast(page);
    if (blockedMsg) {
      stopWatching();
      const err = new Error(`Generation error: "${blockedMsg}"`);
      err.retriable = true;
      throw err;
    }

    const currentUrls = await getExistingImageUrls(page);
    for (const url of currentUrls) {
      if (targetGenId && url.includes(targetGenId)) {
        foundUrls.add(url);
      } else if (!targetGenId && !baselineUrls.includes(url)) {
        foundUrls.add(url);
      }
    }

    if (foundUrls.size > 0) {
      await page.waitForTimeout(3000);
      stopWatching();
      const cleanUrls = Array.from(foundUrls).map((u) => u.split('?')[0]);
      return Array.from(new Set(cleanUrls));
    }

    await page.waitForTimeout(2000);
  }

  stopWatching();
  throw new Error('Timed out waiting for new image generation.');
}

async function downloadImage(context, url, destPath, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await context.request.get(url);
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      fs.writeFileSync(destPath, await response.body());
      return;
    } catch (err) {
      if (i === attempts) throw new Error(`Failed to download ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

// ---------------------------------------------------------------------
// MAIN EXECUTION
// ---------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const prompts = loadPrompts();
  const results = loadResults();

  console.log('Attaching to Chrome instance...');
  const { context, page } = await attachToChrome({
    urlPattern: TARGET_URL_PATTERN,
    fallbackUrl: FALLBACK_URL,
  });

  // Ensure current tab is on Lucid Origin Ultra
  if (!page.url().includes('model=lucid-origin')) {
    console.log('Redirecting to Lucid Origin Ultra preset...');
    await page.goto(FALLBACK_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  console.log(`Attached successfully! Active URL: ${page.url()}`);

  for (const { id, prompt } of prompts) {
    if (results[id]?.status === 'done') {
      console.log(`[${id}] Already generated — skipping.`);
      continue;
    }

    let completed = false;
    let attempt = 0;

    while (!completed) {
      attempt++;
      console.log(`\n[${id}] Attempt ${attempt}: "${prompt.slice(0, 60)}..."`);

      try {
        const baselineImages = await getExistingImageUrls(page);

        // 1. Submit prompt
        const genId = await submitPrompt(page, context, prompt);
        if (genId) {
          console.log(`[${id}] Submitted! Target Generation ID: ${genId}`);
        } else {
          console.log(`[${id}] Submitted! (Tracking via DOM changes)`);
        }

        // 2. Wait for image render
        const imageUrls = await waitForNewImages(
          page,
          context,
          genId,
          baselineImages,
          GENERATION_TIMEOUT_MS
        );
        console.log(`[${id}] Detected ${imageUrls.length} new image(s). Downloading...`);

        // 3. Save to /outputs
        const savedPaths = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const destPath = path.join(OUTPUT_DIR, `${id}_${i}.png`);
          await downloadImage(context, imageUrls[i], destPath);
          savedPaths.push(destPath);
        }

        results[id] = {
          status: 'done',
          prompt,
          generationId: genId || 'n/a',
          files: savedPaths,
          completedAt: new Date().toISOString(),
        };
        saveResults(results);
        console.log(`[${id}] ✅ Successfully saved to outputs/`);

        completed = true;
        await page.waitForTimeout(2500);
      } catch (err) {
        console.warn(`[${id}] Attempt ${attempt} failed: ${err.message}`);
        results[id] = { status: 'retrying', prompt, lastError: err.message, attempts: attempt };
        saveResults(results);
        console.log(`[${id}] Retrying in ${QUEUE_RETRY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, QUEUE_RETRY_DELAY_MS));
      }
    }
  }

  console.log('\n🎉 Pipeline complete! All images saved to outputs/.');
}

main().catch((err) => {
  console.error('Fatal execution error:', err);
  process.exit(1);
});