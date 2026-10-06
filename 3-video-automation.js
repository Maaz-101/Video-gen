/**
 * STEP 3: VIDEO AUTOMATION (HAILUO-2_3 ENGINE WITH STRICT MUTATION CAPTURE & QUEUE SYNC)
 */

const path = require('path');
const fs = require('fs');
const { attachToChrome, watchAllResponses } = require('./lib/attach');

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const FALLBACK_URL =
  'https://leonardo2.testingg.in/generate?model=hailuo-2_3&aspectRatio=16:9&size=RESOLUTION_768&duration=10&quantity=1&seedEnabled=false&negativePromptEnabled=false';
const TARGET_URL_PATTERN = /leonardo\.ai|jintools\.com|testingg\.in/;

const PROMPTS_FILE = path.join(__dirname, 'video_prompts.json');
const RESULTS_FILE = path.join(__dirname, 'video_results.json');
const IMAGES_DIR = path.join(__dirname, 'outputs');
const OUTPUT_DIR = path.join(__dirname, 'outputs_video');

const GENERATION_TIMEOUT_MS = 6 * 60 * 1000; // 6 min max wait for video renders
const QUEUE_RETRY_DELAY_MS = 15 * 1000;      // 15 sec delay on queue limit

// ---------------------------------------------------------------------
// SELECTORS
// ---------------------------------------------------------------------
const PROMPT_INPUT_SELECTORS = [
  'textarea[placeholder*="prompt" i]',
  '[placeholder*="Type a prompt" i]',
  '[placeholder*="prompt" i]',
  'input[placeholder*="prompt" i]',
  'div[contenteditable="true"]',
  'textarea',
];

const GENERATE_BUTTON_SELECTORS = [
  'button[aria-label="Generate"]:visible',
  'button:has-text("Generate"):visible',
  'button:has-text("Create"):visible',
  'button[type="submit"]:visible',
];

const BLOCKING_ERROR_PATTERNS = [
  /pending generations? limit/i,
  /queue.*full/i,
  /too many (pending|generations|jobs)/i,
  /please wait/i,
  /try again/i,
  /failed/i,
];

const ERROR_TOAST_SELECTORS = [
  '[role="alert"]',
  'div[class*="toast"]',
  'div[class*="notification"]',
];

const GRAPHQL_URL_PATTERN = /(\/v1\/graphql|\/api\/graphql|graphql)/i;

// ---------------------------------------------------------------------
// DOWNLOAD HELPER
// ---------------------------------------------------------------------
async function downloadVideo(context, url, destPath, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await context.request.get(url);
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      fs.writeFileSync(destPath, await response.body());
      return;
    } catch (err) {
      if (i === attempts) throw new Error(`Failed to download ${url} after ${attempts} attempts: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

// ---------------------------------------------------------------------
// FILE HELPERS
// ---------------------------------------------------------------------
function loadPrompts() {
  const fileToLoad = fs.existsSync(PROMPTS_FILE) ? PROMPTS_FILE : path.join(__dirname, 'prompts.json');
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

function getStartFrameImagePath(sceneId) {
  const candidates = [
    path.join(IMAGES_DIR, `${sceneId}_0.png`),
    path.join(IMAGES_DIR, `${sceneId}.png`),
    path.join(IMAGES_DIR, `${sceneId}_0.jpg`),
    path.join(IMAGES_DIR, `${sceneId}.jpg`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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

async function clearStaleToasts(page) {
  try {
    for (const sel of ERROR_TOAST_SELECTORS) {
      const toasts = page.locator(sel);
      const count = await toasts.count();
      for (let i = 0; i < count; i++) {
        const t = toasts.nth(i);
        if (await t.isVisible().catch(() => false)) {
          const closeBtn = t.locator('button').first();
          if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click({ force: true }).catch(() => { });
          }
        }
      }
    }
    await page.evaluate(() => {
      document.querySelectorAll('[role="alert"], div[class*="toast"]').forEach((el) => el.remove());
    }).catch(() => { });
  } catch (_) { }
}

async function checkForBlockingToast(page) {
  for (const sel of ERROR_TOAST_SELECTORS) {
    const el = page.locator(sel).first();
    if ((await el.count()) && (await el.isVisible().catch(() => false))) {
      const text = (await el.innerText().catch(() => '')).trim();

      const isTokenWarning =
        text.includes('out of tokens') ||
        text.includes('monthly fast tokens') ||
        text.includes('no tokens left') ||
        text.includes('insufficient tokens') ||
        text.includes('add tokens');

      if (isTokenWarning) continue;

      if (text && text.length < 250 && BLOCKING_ERROR_PATTERNS.some((re) => re.test(text))) {
        return text;
      }
    }
  }
  return null;
}

async function dismissBlockingOverlaysAndTooltips(page) {
  try {
    const closeChecklistBtn = page.locator('button[aria-label="Close checklist"]:visible').first();
    if (await closeChecklistBtn.isVisible({ timeout: 400 }).catch(() => false)) {
      await closeChecklistBtn.click({ force: true }).catch(() => { });
      await page.waitForTimeout(300);
    }

    const modalCloseBtn = page.locator('div[role="dialog"] button[aria-label*="Close" i]:visible').first();
    if (await modalCloseBtn.isVisible({ timeout: 400 }).catch(() => false)) {
      await modalCloseBtn.click({ force: true }).catch(() => { });
      await page.waitForTimeout(300);
    }
  } catch (_) { }
}

async function removePreviousStartFrame(page) {
  try {
    const removeBtn = page.locator('button[aria-label*="Remove Start Frame" i]').first();

    if (await removeBtn.count() > 0) {
      console.log(`[UI] Found existing start frame. Clicking remove button...`);
      await removeBtn.click({ force: true });
      await page.waitForTimeout(600);

      await removeBtn.waitFor({ state: 'detached', timeout: 5000 }).catch(() => { });
      console.log(`[UI] Previous start frame removed cleanly.`);
    }
  } catch (err) {
    console.warn(`[UI] Notice while clearing previous frame: ${err.message}`);
  }
}

async function uploadStartFrameImage(page, imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Start frame image not found on disk: ${imagePath}`);
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await dismissBlockingOverlaysAndTooltips(page);
  await clearStaleToasts(page);

  await removePreviousStartFrame(page);

  const addRefBtn = page.locator('button[data-slot="popover-trigger"][aria-label="Add reference to generation"]:visible').first();
  await addRefBtn.waitFor({ state: 'visible', timeout: 6000 });
  await addRefBtn.click({ force: true });
  await page.waitForTimeout(600);

  const startFrameCard = page.locator('div:has-text("Start frame"), span:has-text("Start frame")').last();
  await startFrameCard.waitFor({ state: 'visible', timeout: 6000 });
  await startFrameCard.click({ force: true });
  await page.waitForTimeout(800);

  const fileInput = page.locator('input[type="file"]').first();
  let uploaded = false;

  if (await fileInput.count() > 0) {
    try {
      await fileInput.setInputFiles(imagePath);
      uploaded = true;
      console.log(`[UI] File injected via direct file input.`);
    } catch (_) { }
  }

  if (!uploaded) {
    const uploadBtn = page.locator('button:has-text("Upload an image"), div:has-text("Upload an image")').last();
    await uploadBtn.waitFor({ state: 'visible', timeout: 7000 });

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      uploadBtn.click({ force: true }),
    ]);

    await fileChooser.setFiles(imagePath);
    console.log(`[UI] File passed to native file dialog.`);
  }

  console.log(`[UI] Waiting for start frame thumbnail to mount...`);
  await page.locator('button[aria-label*="Remove Start Frame" i]').waitFor({
    state: 'attached',
    timeout: 15000,
  });

  await dismissBlockingOverlaysAndTooltips(page);
  console.log(`✅ Successfully attached start frame: ${path.basename(imagePath)}`);
  return true;
}

function extractGenerationIdFromResponse(json) {
  if (!json || typeof json !== 'object') return null;

  if (json?.data?.generate?.generationId) return json.data.generate.generationId;
  if (json?.data?.sdGenerationJob?.generationId) return json.data.sdGenerationJob.generationId;
  if (json?.data?.insert_generations_one?.id) return json.data.insert_generations_one.id;
  if (json?.generationId) return json.generationId;
  if (json?.id && typeof json.id === 'string' && json.id.length > 15) return json.id;

  return null;
}

async function submitAndGetGenerationId(page, context, promptText, imagePath, shouldUpload = true) {
  if (imagePath && shouldUpload) {
    console.log(`Attaching start frame image: ${path.basename(imagePath)}`);
    await uploadStartFrameImage(page, imagePath);
  } else if (!shouldUpload) {
    console.log(`Image already attached. Re-submitting prompt...`);
  }

  const inputSel = await findSelector(page, PROMPT_INPUT_SELECTORS);
  if (!inputSel) throw new Error('Could not find video prompt input field.');

  const cleanPrompt = promptText.replace(/\r?\n|\r/g, ' ').trim();
  const input = page.locator(inputSel).first();

  await input.click({ force: true });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
  if (tagName === 'textarea' || tagName === 'input') {
    await input.fill(cleanPrompt);
  } else {
    await page.keyboard.type(cleanPrompt, { delay: 5 });
  }

  await input.dispatchEvent('input', { bubbles: true }).catch(() => { });
  await page.waitForTimeout(500);

  await dismissBlockingOverlaysAndTooltips(page);
  await clearStaleToasts(page);

  const buttonSel = await findSelector(page, GENERATE_BUTTON_SELECTORS);
  if (!buttonSel) throw new Error('Could not find Generate button.');

  const button = page.locator(buttonSel).first();
  if (!(await button.isEnabled())) {
    const err = new Error('Generate button disabled (queue full or out of tokens).');
    err.retriable = true;
    err.uploadSucceeded = true;
    throw err;
  }

  let capturedGenId = null;

  const stopWatching = watchAllResponses(context, async (response) => {
    if (!GRAPHQL_URL_PATTERN.test(response.url())) return;

    try {
      const req = response.request();
      if (req.method() !== 'POST') return;
    } catch { }

    try {
      const json = await response.json();
      const genId = extractGenerationIdFromResponse(json);
      if (genId) {
        capturedGenId = genId;
        stopWatching();
      }
    } catch { }
  });

  await button.click({ force: true });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !capturedGenId) {
    await page.waitForTimeout(500);

    if (capturedGenId) break;

    const blockedMsg = await checkForBlockingToast(page);
    if (blockedMsg) {
      if (capturedGenId) break;

      stopWatching();
      const err = new Error(`Leonardo rejected video submission: "${blockedMsg}"`);
      err.retriable = true;
      err.uploadSucceeded = true;
      throw err;
    }
  }

  stopWatching();

  if (!capturedGenId) {
    const err = new Error('Clicked Generate but failed to capture video generationId from network response.');
    err.retriable = true;
    err.uploadSucceeded = true;
    throw err;
  }

  return { myGenId: capturedGenId };
}

function extractVideoUrlForTargetGenId(json, targetGenId) {
  if (!json || !json.data) return null;

  let candidates = [];
  if (Array.isArray(json.data.generations)) {
    candidates = json.data.generations;
  } else if (json.data.generations_by_pk) {
    candidates = [json.data.generations_by_pk];
  } else if (json.data.generate) {
    candidates = [json.data.generate];
  }

  for (const item of candidates) {
    if (item && (item.id === targetGenId || item.generationId === targetGenId)) {
      const itemStr = JSON.stringify(item);
      const matches = itemStr.match(/https?:\/\/[^"\s]+\.mp4(?:\?[^"\s]*)?/gi);
      if (matches && matches.length > 0) {
        return matches[0].replace(/\\/g, '').split('?')[0];
      }
    }
  }

  return null;
}

async function waitForTargetVideoUrls(page, context, targetGenId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const foundUrls = new Set();

  const stopWatching = watchAllResponses(context, async (response) => {
    if (!GRAPHQL_URL_PATTERN.test(response.url())) return;
    try {
      const json = await response.json();
      const validUrl = extractVideoUrlForTargetGenId(json, targetGenId);
      if (validUrl) {
        foundUrls.add(validUrl);
      }
    } catch { }
  });

  while (Date.now() < deadline) {
    if (foundUrls.size > 0) {
      await page.waitForTimeout(2000);
      stopWatching();

      const uniqueUrls = Array.from(foundUrls);
      console.log(`[Matching] Locked onto targetGenId ${targetGenId} -> ${uniqueUrls[0]}`);
      return uniqueUrls;
    }

    await page.waitForTimeout(2000);
  }

  stopWatching();
  const err = new Error(`Timed out waiting for MP4 video matching generation ID: ${targetGenId}`);
  err.retriable = true;
  throw err;
}

// ---------------------------------------------------------------------
// MAIN EXECUTION LOOP
// ---------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const prompts = loadPrompts();
  const results = loadResults();

  console.log('Attaching to Chrome for Video Generation...');
  const { context, page } = await attachToChrome({
    urlPattern: TARGET_URL_PATTERN,
    fallbackUrl: FALLBACK_URL,
  });

  // Verify and enforce page is on hailuo-2_3 model preset
  if (!page.url().includes('model=hailuo-2_3')) {
    console.log(`Navigating to Hailuo-2.3 preset: ${FALLBACK_URL}`);
    await page.goto(FALLBACK_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }

  console.log(`Attached successfully. Active URL: ${page.url()}`);

  for (const { id, prompt } of prompts) {
    if (results[id]?.status === 'done') {
      console.log(`[${id}] Already completed — skipping.`);
      continue;
    }

    const startFramePath = getStartFrameImagePath(id);
    let completed = false;
    let attempt = 0;
    let hasUploadedImage = false;

    while (!completed) {
      attempt++;
      console.log(`\n[${id}] Video Attempt ${attempt}: "${prompt.slice(0, 60)}..."`);

      try {
        const { myGenId } = await submitAndGetGenerationId(
          page,
          context,
          prompt,
          startFramePath,
          !hasUploadedImage
        );

        hasUploadedImage = true;

        console.log(`[${id}] Submitted successfully! Locked onto Video Generation ID: ${myGenId}`);
        console.log(`[${id}] Waiting for video rendering to finish (1-3 min)...`);

        const videoUrls = await waitForTargetVideoUrls(page, context, myGenId, GENERATION_TIMEOUT_MS);
        console.log(`[${id}] Match found! Captured ${videoUrls.length} MP4 video file(s) for ID ${myGenId}`);

        const savedPaths = [];
        for (let i = 0; i < videoUrls.length; i++) {
          const destPath = path.join(OUTPUT_DIR, `${id}_${i}.mp4`);
          await downloadVideo(context, videoUrls[i], destPath);
          savedPaths.push(destPath);
        }

        results[id] = {
          status: 'done',
          prompt,
          myGenId,
          startFrame: startFramePath,
          files: savedPaths,
          completedAt: new Date().toISOString(),
        };
        saveResults(results);
        console.log(`[${id}] ✅ Saved ${savedPaths.length} MP4 video file(s) to outputs_video/`);

        completed = true;
        hasUploadedImage = false;
        await page.waitForTimeout(2000);
      } catch (err) {
        console.warn(`[${id}] Attempt ${attempt} failed: ${err.message}`);
        results[id] = { status: 'retrying', prompt, lastError: err.message, attempts: attempt };
        saveResults(results);

        await page.keyboard.press('Escape').catch(() => { });
        await clearStaleToasts(page);
        await page.waitForTimeout(500);

        if (err.uploadSucceeded) {
          hasUploadedImage = true;
        } else {
          hasUploadedImage = false;
        }

        const waitTime = /pending generations? limit/i.test(err.message) ? QUEUE_RETRY_DELAY_MS : 5000;
        console.log(`[${id}] Retrying in ${waitTime / 1000}s...`);
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }
  }

  console.log('\n🎉 All video scenes processed successfully!');
}

main().catch((err) => {
  console.error('Fatal video execution error:', err);
  process.exit(1);
});