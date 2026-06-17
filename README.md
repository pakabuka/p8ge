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


## Deploy on Render

Recommended setup: deploy this as a **Web Service** using the included `Dockerfile`.

1. Push this folder to a GitHub repository.
2. In Render, choose **Create new service** > **Web Service**.
3. Connect your GitHub repository.
4. Choose **Docker** as the runtime if Render asks for runtime/environment.
5. Leave Root Directory blank if these files are at the repo root.
6. Choose the Free plan and click **Deploy Web Service**.

The app reads Render's `PORT` environment variable automatically.
