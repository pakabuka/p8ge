const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const archiver = require('archiver');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAPSHOT_ROOT = path.join(ROOT, 'data', 'snapshots');
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CAPTURED_ASSETS = 60;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

const jobs = new Map();
const queue = [];
let activeJobId = null;

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use('/snapshot-assets', express.static(SNAPSHOT_ROOT, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));
app.use(express.static(PUBLIC_DIR));

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('Please enter a URL.');
  const trimmed = input.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are supported.');
  return parsed.toString();
}

function makeId() {
  return crypto.randomBytes(4).toString('hex');
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getRequestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function getViewport() {
  return {
    width: 1280,
    height: 900,
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1
  };
}

function looksLikePdfUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return /\.pdf$/i.test(parsed.pathname);
  } catch {
    return /\.pdf(?:[?#].*)?$/i.test(targetUrl);
  }
}

function getPdfDisplayTitle(urlOrName, fallback = 'Web Snapshot PDF') {
  try {
    const parsed = new URL(urlOrName);
    const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || '').trim();
    return fileName || fallback;
  } catch {
    const fileName = path.basename(String(urlOrName || '').trim());
    return fileName || fallback;
  }
}

function makeSafePdfFileName(title, fallback = 'snapshot.pdf') {
  const cleaned = String(title || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned || fallback.replace(/\.pdf$/i, '');
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

function getExtensionFromUrl(urlString, fallback = '') {
  try {
    const parsed = new URL(urlString);
    const ext = path.extname(parsed.pathname || '').toLowerCase();
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function makeSafeAssetName(prefix, index, extension, fallbackExtension = '') {
  const safeExtension = extension || fallbackExtension || '';
  return `${prefix}-${String(index).padStart(2, '0')}${safeExtension}`;
}

function replaceAllLiteral(source, search, replacement) {
  if (!search) return source;
  return source.split(search).join(replacement);
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function ensureSnapshotDir(id) {
  const dir = path.join(SNAPSHOT_ROOT, id);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function getSnapshotMeta(id) {
  const metaPath = path.join(SNAPSHOT_ROOT, id, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  return readJson(metaPath);
}

async function cleanupExpiredSnapshots() {
  await fsp.mkdir(SNAPSHOT_ROOT, { recursive: true });
  const entries = await fsp.readdir(SNAPSHOT_ROOT, { withFileTypes: true });
  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(SNAPSHOT_ROOT, entry.name);
    const metaPath = path.join(dirPath, 'meta.json');
    let createdAt = 0;

    if (fs.existsSync(metaPath)) {
      try {
        const meta = await readJson(metaPath);
        createdAt = new Date(meta.createdAt || 0).getTime();
      } catch {
        createdAt = 0;
      }
    }

    if (!createdAt || createdAt < cutoff) {
      await fsp.rm(dirPath, { recursive: true, force: true });
    }
  }
}

async function createZipFromSnapshot(id) {
  const snapshotDir = path.join(SNAPSHOT_ROOT, id);
  if (!fs.existsSync(snapshotDir)) return null;

  const tempPath = path.join(os.tmpdir(), `websnapshot-${id}-${Date.now()}.zip`);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tempPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(tempPath));
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(snapshotDir, false);
    archive.finalize();
  });
}

async function settlePage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    // Long-running sockets and analytics should not block capture.
  }
  await page.waitForTimeout(800);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = Math.max(500, Math.floor(window.innerHeight * 0.9));
      const max = Math.min(12000, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= max) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          setTimeout(resolve, 300);
        }
      }, 120);
    });
  });
}

async function tryDownloadPdfFromUrl(targetUrl) {
  const likelyPdf = looksLikePdfUrl(targetUrl);
  let contentType = '';

  try {
    const head = await fetch(targetUrl, { method: 'HEAD', redirect: 'follow' });
    if (head.ok) {
      contentType = (head.headers.get('content-type') || '').toLowerCase();
      if (!likelyPdf && !contentType.includes('application/pdf')) return null;
    }
  } catch {
    if (!likelyPdf) return null;
  }

  const response = await fetch(targetUrl, { method: 'GET', redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to download the PDF (${response.status} ${response.statusText}).`);

  const finalType = (response.headers.get('content-type') || contentType || '').toLowerCase();
  const finalUrl = response.url || targetUrl;
  if (!looksLikePdfUrl(finalUrl) && !likelyPdf && !finalType.includes('application/pdf')) return null;

  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  if (!pdfBuffer.length) throw new Error('The PDF download was empty.');

  return {
    pdfBuffer,
    finalUrl,
    title: getPdfDisplayTitle(finalUrl, 'Web Snapshot PDF')
  };
}

async function saveCapturedSitePackage({ snapshotRootDir, publicBasePath, page, targetUrl, id }) {
  const packageDir = path.join(snapshotRootDir, 'page');
  await fsp.mkdir(path.join(packageDir, 'css'), { recursive: true });
  await fsp.mkdir(path.join(packageDir, 'js'), { recursive: true });
  await fsp.mkdir(path.join(packageDir, 'images'), { recursive: true });

  const snapshot = await page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).map((node) => ({
      absolute: node.href,
      original: node.getAttribute('href') || node.href
    })),
    scripts: Array.from(document.querySelectorAll('script[src]')).map((node) => ({
      absolute: node.src,
      original: node.getAttribute('src') || node.src
    })),
    images: Array.from(document.querySelectorAll('img[src], source[src], source[srcset]')).flatMap((node) => {
      const srcset = node.getAttribute('srcset');
      if (srcset) {
        return srcset
          .split(',')
          .map((part) => part.trim().split(/\s+/)[0])
          .filter(Boolean)
          .map((value) => ({ absolute: new URL(value, document.baseURI).toString(), original: value }));
      }
      const src = node.getAttribute('src');
      if (!src) return [];
      return [{ absolute: node.src, original: src }];
    })
  }));

  let html = String(snapshot.html || '')
    .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '');

  let assetCount = 0;
  const fetchAndSaveAsset = async ({ absolute, original }, folder, index, fallbackExt) => {
    try {
      if (assetCount >= MAX_CAPTURED_ASSETS) return null;
      if (!/^https?:\/\//i.test(absolute)) return null;

      const response = await fetch(absolute, { redirect: 'follow' });
      if (!response.ok) return null;

      const length = Number(response.headers.get('content-length') || '0');
      if (length && length > MAX_ASSET_BYTES) return null;

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_ASSET_BYTES) return null;

      const buffer = Buffer.from(arrayBuffer);
      if (!buffer.length) return null;

      const ext = getExtensionFromUrl(absolute, fallbackExt) || fallbackExt;
      const fileName = makeSafeAssetName(folder.slice(0, -1) || folder, index + 1, ext, fallbackExt);
      const relativePath = `${folder}/${fileName}`;
      await fsp.writeFile(path.join(packageDir, relativePath), buffer);

      html = replaceAllLiteral(html, original, relativePath);
      html = replaceAllLiteral(html, absolute, relativePath);
      assetCount += 1;
      return relativePath;
    } catch {
      return null;
    }
  };

  const seen = new Set();
  const allEntries = [
    ...((snapshot.stylesheets || []).map((entry, index) => ({ entry, folder: 'css', index, ext: '.css', type: 'css' }))),
    ...((snapshot.scripts || []).map((entry, index) => ({ entry, folder: 'js', index, ext: '.js', type: 'js' }))),
    ...((snapshot.images || []).map((entry, index) => ({ entry, folder: 'images', index, ext: '.bin', type: 'img' })))
  ];

  for (const item of allEntries) {
    const key = `${item.type}:${item.entry.absolute}`;
    if (!item.entry?.absolute || seen.has(key)) continue;
    seen.add(key);
    await fetchAndSaveAsset(item.entry, item.folder, item.index, item.ext);
  }

  const metaTag = `<meta name="web-snapshot-original-url" content="${escapeHtml(targetUrl)}">`;
  html = /<head(.*?)>/i.test(html)
    ? html.replace(/<head(.*?)>/i, `<head$1>${metaTag}`)
    : `${metaTag}\n${html}`;

  await fsp.writeFile(path.join(packageDir, 'index.html'), `<!DOCTYPE html>\n${html}`, 'utf8');
  return {
    pagePreviewPath: `${publicBasePath}/${id}/page/index.html`,
    packagedHtmlPath: `${publicBasePath}/${id}/page/index.html`,
    capturedAssetCount: assetCount
  };
}

async function createPdfSnapshot({ origin, id, pdfBuffer, originalUrl, title }) {
  const snapshotDir = await ensureSnapshotDir(id);
  const pdfFile = path.join(snapshotDir, 'capture.pdf');
  await fsp.writeFile(pdfFile, pdfBuffer);

  const meta = {
    id,
    title,
    originalUrl,
    createdAt: new Date().toISOString(),
    kind: 'pdf',
    previewType: 'pdf',
    downloadFileName: `${makeSafePdfFileName(title, `${id}.pdf`).replace(/\.pdf$/i, '')}.zip`,
    downloadUrl: `${origin}/download/${id}`,
    previewUrl: `${origin}/preview/${id}`
  };

  await writeJson(path.join(snapshotDir, 'meta.json'), meta);
  return meta;
}

async function captureCurrentSnapshot({ origin, page, id, targetUrl, onProgress }) {
  const snapshotDir = await ensureSnapshotDir(id);
  const previewFile = path.join(snapshotDir, 'preview.png');
  const pdfFile = path.join(snapshotDir, 'capture.pdf');

  onProgress(40, 'Waiting for page to settle…');
  await settlePage(page);

  onProgress(52, 'Scrolling page…');
  await autoScroll(page);

  const title = (await page.title())?.trim() || new URL(targetUrl).hostname;

  onProgress(64, 'Saving preview image…');
  await page.screenshot({
    path: previewFile,
    fullPage: false,
    type: 'png'
  });

  onProgress(76, 'Creating PDF…');
  await page.pdf({
    path: pdfFile,
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: false,
    margin: {
      top: '0.5in',
      right: '0.5in',
      bottom: '0.5in',
      left: '0.5in'
    }
  });

  onProgress(88, 'Packaging page assets…');
  const packageMeta = await saveCapturedSitePackage({
    snapshotRootDir: snapshotDir,
    publicBasePath: '/snapshot-assets',
    page,
    targetUrl,
    id
  });

  const meta = {
    id,
    title,
    originalUrl: targetUrl,
    createdAt: new Date().toISOString(),
    kind: 'webpage',
    previewType: 'image',
    pagePreviewPath: packageMeta.pagePreviewPath,
    packagedHtmlPath: packageMeta.packagedHtmlPath,
    capturedAssetCount: packageMeta.capturedAssetCount,
    downloadFileName: `${makeSafePdfFileName(title, `${id}.pdf`).replace(/\.pdf$/i, '')}.zip`,
    downloadUrl: `${origin}/download/${id}`,
    previewUrl: `${origin}/preview/${id}`
  };

  await writeJson(path.join(snapshotDir, 'meta.json'), meta);
  return meta;
}

async function captureUrlSnapshot({ origin, targetUrl, onProgress }) {
  let browser;
  try {
    await cleanupExpiredSnapshots().catch(() => {});

    onProgress(8, 'Checking URL…');
    const pdfDownload = await tryDownloadPdfFromUrl(targetUrl);
    if (pdfDownload) {
      onProgress(75, 'Saving PDF…');
      const id = makeId();
      return createPdfSnapshot({
        origin,
        id,
        pdfBuffer: pdfDownload.pdfBuffer,
        originalUrl: pdfDownload.finalUrl,
        title: pdfDownload.title
      });
    }

    onProgress(18, 'Launching renderer…');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--hide-scrollbars'
      ]
    });

    const page = await browser.newPage({ viewport: getViewport() });
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(30000);

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    onProgress(28, 'Opening page…');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const id = makeId();
    return captureCurrentSnapshot({ origin, page, id, targetUrl, onProgress });
  } finally {
    await browser?.close().catch(() => {});
  }
}

function cleanupOldJobs() {
  const cutoff = Date.now() - JOB_MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if (job.createdAtMs < cutoff) jobs.delete(id);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    progress: job.progress,
    message: job.message,
    snapshot: job.snapshot || null,
    error: job.error || null
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAtMs: Date.now() });
}

function enqueueJob(job) {
  queue.push(job.id);
  runNextJob();
}

async function runNextJob() {
  if (activeJobId || !queue.length) return;
  const id = queue.shift();
  const job = jobs.get(id);
  if (!job) return runNextJob();

  activeJobId = id;
  updateJob(job, { status: 'rendering', progress: 3, message: 'Queued renderer is starting…' });

  try {
    const snapshot = await captureUrlSnapshot({
      origin: job.origin,
      targetUrl: job.url,
      onProgress: (progress, message) => updateJob(job, { progress, message })
    });
    updateJob(job, { status: 'done', progress: 100, message: 'Snapshot ready.', snapshot });
  } catch (error) {
    updateJob(job, {
      status: 'error',
      progress: 0,
      message: error.message || 'Capture failed.',
      error: error.message || 'Capture failed.'
    });
  } finally {
    activeJobId = null;
    setImmediate(runNextJob);
  }
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/snapshot-job', (req, res) => {
  try {
    cleanupOldJobs();
    const url = normalizeUrl(req.body.url);
    const id = makeId();
    const job = {
      id,
      url,
      origin: getRequestOrigin(req),
      status: 'queued',
      progress: 0,
      message: 'Queued.',
      snapshot: null,
      error: null,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };

    jobs.set(id, job);
    enqueueJob(job);
    res.json({ ok: true, job: publicJob(job) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not start snapshot.' });
  }
});

app.get('/api/snapshot-job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Snapshot job not found.' });
  res.json({ ok: true, job: publicJob(job) });
});

app.post('/api/snapshot', async (req, res) => {
  try {
    const targetUrl = normalizeUrl(req.body.url);
    const snapshot = await captureUrlSnapshot({
      origin: getRequestOrigin(req),
      targetUrl,
      onProgress: () => {}
    });
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not capture this webpage.' });
  }
});

app.get('/preview/:id', async (req, res) => {
  const meta = await getSnapshotMeta(req.params.id);
  if (!meta) return res.status(404).send('Snapshot not found.');

  if (meta.previewType === 'pdf') {
    const pdfPath = path.join(SNAPSHOT_ROOT, req.params.id, 'capture.pdf');
    if (!fs.existsSync(pdfPath)) return res.status(404).send('Preview not found.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${req.params.id}.pdf"`);
    return res.sendFile(pdfPath);
  }

  const imagePath = path.join(SNAPSHOT_ROOT, req.params.id, 'preview.png');
  if (!fs.existsSync(imagePath)) return res.status(404).send('Preview not found.');
  res.setHeader('Content-Type', 'image/png');
  return res.sendFile(imagePath);
});

app.get('/download/:id', async (req, res) => {
  const meta = await getSnapshotMeta(req.params.id);
  if (!meta) return res.status(404).send('Snapshot not found.');

  let tempZipPath = null;
  try {
    tempZipPath = await createZipFromSnapshot(req.params.id);
    if (!tempZipPath || !fs.existsSync(tempZipPath)) return res.status(404).send('Snapshot package not found.');

    res.download(tempZipPath, meta.downloadFileName || `${req.params.id}.zip`, async () => {
      if (tempZipPath) await fsp.unlink(tempZipPath).catch(() => {});
    });
  } catch (error) {
    if (tempZipPath) await fsp.unlink(tempZipPath).catch(() => {});
    res.status(500).send(error.message || 'Could not build the snapshot package.');
  }
});

app.listen(PORT, () => {
  console.log(`p8ge.cc Web Snapshot running on port ${PORT}`);
});
