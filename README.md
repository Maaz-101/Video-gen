# Leonardo batch-generation automation

Drives Leonardo (lucid-origin, via app.jintools.com) through a queue of
prompts, tracks each generation by its unique ID (not its position in the
feed, since that reorders as other generations finish), and downloads the
finished image for each one.

## Why this uses "attach" instead of "launch"

Chrome blocks remote-debugging/automation on its **default** profile
directory as a security measure, no matter which `--profile-directory`
flag you pass. That makes it unreliable for Playwright to *launch* Chrome
itself when you need your real profile + extension.

Instead, the workflow here is:
1. You launch a real Chrome window yourself, from a copied (non-default)
   profile folder, with remote debugging enabled — your extension and
   login are already there.
2. The scripts **attach** to that already-running window via Chrome
   DevTools Protocol (CDP) and drive whichever tab is open, scanning for
   the right one by URL rather than assuming position.

## One-time setup

```bash
npm install
```
(Playwright's bundled browser isn't needed for this workflow since you're
driving your real Chrome — `npx playwright install chromium` is optional.)

### Copy your Chrome profile to a non-default location

Close Chrome completely, then open `windows/copy-profile.bat`, edit the
`SOURCE`, `DEST`, and `PROFILE_FOLDER` values at the top to match your
machine, and run it.

To find your real profile's folder name: open the Chrome profile with the
extension, go to `chrome://version`, and check **Profile Path** — the
last folder in that path (e.g. `Profile 39`) is `PROFILE_FOLDER`.

You can re-run this script any time to refresh the automation profile
from your real one (e.g. after logging in again).

## Every time you want to run the automation

### 1. Launch Chrome

Open `windows/launch-chrome.bat` (edit `DEST`/`PROFILE_FOLDER` at the top
to match what you used in copy-profile.bat, if different). A real Chrome
window opens with your extension loaded.

In that window, log in if needed, navigate to the Leonardo generate page
(lucid-origin model) via jintools, and leave it on that tab.

### 2. Discover the real API shapes (only needed once, ever)

```bash
npm run discover
```

This attaches to the Chrome window from step 1 and logs every relevant
API response to the console and to `discovery-log.txt`. In the Chrome
window, submit **one** test prompt and wait for it to finish generating,
then come back here and press `Ctrl+C`.

From `discovery-log.txt`, find:
- the response that fired the moment you clicked **Generate** (has the
  new generation's ID in it)
- the response that shows up once the image is **done** (has a status
  field and the final image URL(s) in it)

### 3. Fill in the automation script

Open `2-generate-automation.js` and fill in the `TODO` sections near the
top using what you found in step 2:
1. Prompt textarea / Generate button selectors
2. How to pull the generation ID out of the "created" response
3. How to read status + image URLs out of the "status" response for a
   given generation ID

### 4. Add your prompts

Put your generated prompts in `prompts.json` in this folder (see
`prompts.example.json` for the accepted formats — plain strings, or
`{ id, prompt }` objects if you want stable IDs across reruns).

### 5. Run it

With Chrome still open from step 1:

```bash
npm run generate
```

- Runs one prompt at a time, in order.
- Progress is saved to `results.json` after every prompt — if the script
  crashes or you stop it, rerunning `npm run generate` will skip prompts
  already marked `"done"` and pick up where it left off.
- Downloaded images land in `outputs/`, named `<id>_<index>.png`.
- The script does not close your Chrome window when it finishes — it's
  your real browser, launched outside the script.

## Notes / things worth checking before running at volume

- Automating a third party's web UI like this can bump into their Terms
  of Service (bot detection, rate limits). Worth a quick check of
  Leonardo's and jintools.com's terms if you're planning a large batch.
- `GENERATION_TIMEOUT_MS` (5 min default) may need adjusting depending on
  how long lucid-origin generations actually take for you.
- If a generation's traffic lands on a different tab than the one you're
  typing into (e.g. Leonardo opens results in a new tab), the scripts
  already watch every tab in the browser context, not just one — no
  change needed there.
- If Leonardo ever changes their frontend/API, the selectors and response
  patterns in `2-generate-automation.js` are the only things that should
  need re-discovering — the queue/resume/download logic around them
  shouldn't need to change.
