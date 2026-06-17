# p8ge.cc Web Snapshot Standalone

This is the extracted single-purpose version of the web snapshot feature.

## What it does

- Shows the website name `p8ge.cc`.
- Lets users add multiple links to a queue.
- Each queued link has its own Proceed button.
- When Proceed is clicked, that row is disabled and shows a rendering progress bar.
- Downloads the result as a ZIP package containing the PDF, preview image, metadata, and a basic local copy of page HTML/CSS/JS/images.

## Run locally

```bash
npm install
npx playwright install chromium
npm start
```

Then open:

```text
http://localhost:3000
```

Generated snapshots are stored in `data/snapshots` and cleaned after 24 hours.


## Render 502 note

This version uses an async snapshot job and polling so Render does not have to keep one long `/api/snapshot` request open while Chromium renders. It also lowers memory use by avoiding full-page PNG screenshots, blocking media/fonts, limiting captured assets, and running only one Chromium job at a time.


## ZIP packaging note

This version uses the Node `archiver` package to create ZIP downloads, so it does not depend on the Linux `zip` binary being installed in the Render container.
