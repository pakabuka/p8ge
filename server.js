const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;
const execFileAsync = promisify(execFile);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAPSHOT_ROOT = path.join(ROOT, 'data', 'snapshots');
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

app.use(express.json({ limit: '1mb' }));
app.use('/snapshot-assets', express.static(SNAPSHOT_ROOT, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));
app.use(express.static(PUBLIC_DIR));

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Please enter a URL.');
  }

  const trimmed = input.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

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

function buildAbsoluteUrl(req, pathname) {
  return `${req.protocol}://${req.get('host')}${pathname}`;
}

function getViewport() {
  return {
    width: 1440,
    height: 2000,
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
  await execFileAsync('zip', ['-r', '-q', tempPath, '.'], { cwd: snapshotDir });
  return tempPath;
}

async function settlePage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {
    // Some sites keep websockets or analytics requests alive. That should not block capture.
  }
  await page.waitForTimeout(1200);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
      const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= max) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          setTimeout(resolve, 400);
        }
      }, 175);
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
      if (!likelyPdf && !contentType.includes('application/pdf')) {
        return null;
      }
    }
  } catch {
    if (!likelyPdf) return null;
  }

  const response = await fetch(targetUrl, { method: 'GET', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download the PDF (${response.status} ${response.statusText}).`);
  }

  const finalType = (response.headers.get('content-type') || contentType || '').toLowerCase();
  const finalUrl = response.url || targetUrl;
  if (!looksLikePdfUrl(finalUrl) && !likelyPdf && !finalType.includes('application/pdf')) {
    return null;
  }

  const pdfBuffer = Buffer.from(await response.arrayBuffer());
  if (!pdfBuffer.length) {
    throw new Error('The PDF download was empty.');
  }

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

  const fetchAndSaveAsset = async ({ absolute, original }, folder, index, fallbackExt) => {
    try {
      if (!/^https?:\/\//i.test(absolute)) return null;
      const response = await fetch(absolute, { redirect: 'follow' });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) return null;

      const ext = getExtensionFromUrl(absolute, fallbackExt) || fallbackExt;
      const fileName = makeSafeAssetName(folder.slice(0, -1) || folder, index + 1, ext, fallbackExt);
      const relativePath = `${folder}/${fileName}`;
      await fsp.writeFile(path.join(packageDir, relativePath), buffer);

      html = replaceAllLiteral(html, original, relativePath);
      html = replaceAllLiteral(html, absolute, relativePath);
      return relativePath;
    } catch {
      return null;
    }
  };

  const seen = new Set();
  for (const [index, entry] of (snapshot.stylesheets || []).entries()) {
    const key = `css:${entry.absolute}`;
    if (!entry?.absolute || seen.has(key)) continue;
    seen.add(key);
    await fetchAndSaveAsset(entry, 'css', index, '.css');
  }

  for (const [index, entry] of (snapshot.scripts || []).entries()) {
    const key = `js:${entry.absolute}`;
    if (!entry?.absolute || seen.has(key)) continue;
    seen.add(key);
    await fetchAndSaveAsset(entry, 'js', index, '.js');
  }

  for (const [index, entry] of (snapshot.images || []).entries()) {
    const key = `img:${entry.absolute}`;
    if (!entry?.absolute || seen.has(key)) continue;
    seen.add(key);
    await fetchAndSaveAsset(entry, 'images', index, '.bin');
  }

  const metaTag = `<meta name="web-snapshot-original-url" content="${escapeHtml(targetUrl)}">`;
  html = /<head(.*?)>/i.test(html)
    ? html.replace(/<head(.*?)>/i, `<head$1>${metaTag}`)
    : `${metaTag}\n${html}`;

  await fsp.writeFile(path.join(packageDir, 'index.html'), `<!DOCTYPE html>\n${html}`, 'utf8');
  return {
    pagePreviewPath: `${publicBasePath}/${id}/page/index.html`,
    packagedHtmlPath: `${publicBasePath}/${id}/page/index.html`
  };
}

async function createPdfSnapshot({ req, id, pdfBuffer, originalUrl, title }) {
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
    downloadUrl: buildAbsoluteUrl(req, `/download/${id}`),
    previewUrl: buildAbsoluteUrl(req, `/preview/${id}`)
  };

  await writeJson(path.join(snapshotDir, 'meta.json'), meta);
  return meta;
}

async function captureCurrentSnapshot({ req, page, id, targetUrl }) {
  const snapshotDir = await ensureSnapshotDir(id);
  const previewFile = path.join(snapshotDir, 'preview.png');
  const pdfFile = path.join(snapshotDir, 'capture.pdf');

  await settlePage(page);
  await autoScroll(page);

  const title = (await page.title())?.trim() || new URL(targetUrl).hostname;

  await page.screenshot({
    path: previewFile,
    fullPage: true,
    type: 'png'
  });

  await page.pdf({
    path: pdfFile,
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    margin: {
      top: '0.5in',
      right: '0.5in',
      bottom: '0.5in',
      left: '0.5in'
    }
  });

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
    downloadFileName: `${makeSafePdfFileName(title, `${id}.pdf`).replace(/\.pdf$/i, '')}.zip`,
    downloadUrl: buildAbsoluteUrl(req, `/download/${id}`),
    previewUrl: buildAbsoluteUrl(req, `/preview/${id}`)
  };

  await writeJson(path.join(snapshotDir, 'meta.json'), meta);
  return meta;
}

app.post('/api/snapshot', async (req, res) => {
  let browser;
  try {
    await cleanupExpiredSnapshots().catch(() => {});

    const targetUrl = normalizeUrl(req.body.url);
    const pdfDownload = await tryDownloadPdfFromUrl(targetUrl);

    if (pdfDownload) {
      const id = makeId();
      const snapshot = await createPdfSnapshot({
        req,
        id,
        pdfBuffer: pdfDownload.pdfBuffer,
        originalUrl: pdfDownload.finalUrl,
        title: pdfDownload.title
      });
      return res.json({ ok: true, snapshot });
    }

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: getViewport() });
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(30000);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    const id = makeId();
    const snapshot = await captureCurrentSnapshot({ req, page, id, targetUrl });
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not capture this webpage.' });
  } finally {
    await browser?.close().catch(() => {});
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
    if (!tempZipPath || !fs.existsSync(tempZipPath)) {
      return res.status(404).send('Snapshot package not found.');
    }

    res.download(tempZipPath, meta.downloadFileName || `${req.params.id}.zip`, async () => {
      if (tempZipPath) await fsp.unlink(tempZipPath).catch(() => {});
    });
  } catch (error) {
    if (tempZipPath) await fsp.unlink(tempZipPath).catch(() => {});
    res.status(500).send(error.message || 'Could not build the snapshot package.');
  }
});

app.listen(PORT, () => {
  console.log(`Web Snapshot running at http://localhost:${PORT}`);
});
