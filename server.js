#!/usr/bin/env node
'use strict';

const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const chokidar  = require('chokidar');
const Anthropic = require('@anthropic-ai/sdk');
const { execSync, spawnSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EINGANG = process.env.SCAN_EINGANG || '/home/pi/Scanner/Eingang';
const ARCHIV  = process.env.SCAN_ARCHIV  || '/home/pi/Scanner/Archiv';
const KATEGORIEN = ['Rechnung','Vertrag','Kontoauszug','Versicherung','Brief','Steuer','Behoerde','Medizin','Sonstiges','Pruefen'];

const LOG_DIR    = path.join(__dirname, 'logs');
const ERROR_LOG  = path.join(LOG_DIR, 'error.log');
const STATUS_FILE = path.join(LOG_DIR, 'status.json');

fs.mkdirSync(LOG_DIR, { recursive: true });

// ── Logging ───────────────────────────────────────────────────────────────────
function logError(filename, message) {
  const line = `[${new Date().toISOString()}] [${filename || 'system'}] ${message}\n`;
  try { fs.appendFileSync(ERROR_LOG, line); } catch {}
  console.error(`[DokuScan] ❌ ${message}`);
}

// ── Status-Datei ──────────────────────────────────────────────────────────────
let statusState = {
  queueLength:    0,
  currentFile:    null,
  errorCount:     0,
  processedToday: 0,
  lastUpdated:    null,
};

function loadStatus() {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    const saved = JSON.parse(raw);
    const today = new Date().toISOString().split('T')[0];
    if (saved.date === today) {
      statusState.processedToday = saved.processedToday || 0;
      statusState.errorCount     = saved.errorCount     || 0;
    }
  } catch {}
}

function saveStatus() {
  const today = new Date().toISOString().split('T')[0];
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      ...statusState,
      date:        today,
      lastUpdated: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

loadStatus();

// ── Absturzsicherheit ─────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logError('system', `unhandledRejection: ${reason?.stack || reason}`);
});

process.on('uncaughtException', (err) => {
  logError('system', `uncaughtException: ${err.stack || err.message}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitize(str) {
  return (str||'').replace(/[^a-zA-Z0-9äöüÄÖÜß\-]/g,'_').replace(/_+/g,'_').substring(0,40);
}

function safePath(base, ...segments) {
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

// ── Seitenanzahl ermitteln ────────────────────────────────────────────────────
function getPageCount(filePath) {
  try {
    const out = execSync(`pdfinfo "${filePath}"`, { encoding: 'utf8' });
    const m   = out.match(/Pages:\s+(\d+)/);
    return m ? parseInt(m[1]) : 1;
  } catch { return 1; }
}

// ── Text einer einzelnen Seite extrahieren ────────────────────────────────────
function getPageText(filePath, page) {
  try {
    return execSync(`pdftotext -f ${page} -l ${page} "${filePath}" -`, { encoding: 'utf8' })
      .replace(/\s+/g, ' ').trim().substring(0, 1500);
  } catch { return ''; }
}

// ── Seiten-Fortsetzungssignal erkennen ────────────────────────────────────────
function hasContinuationSignal(text) {
  return /seite\s+\d+\s+(von|of)\s+\d+|page\s+\d+\s+(of|von)\s+\d+|\d+\s*\/\s*\d+\s*seite|fortsetzung|continued|weiter auf|übertrag/i.test(text);
}

// ── Seite als JPEG rendern (für Seiten ohne lesbaren Text) ───────────────────
function renderPageAsBase64(filePath, page) {
  try {
    const tmp = path.join(os.tmpdir(), `ds_p${page}_${Date.now()}`);
    spawnSync('pdftoppm', ['-jpeg', '-r', '200', '-f', String(page), '-l', String(page), filePath, tmp]);

    const dir     = path.dirname(tmp);
    const prefix  = path.basename(tmp) + '-';
    const matches = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.jpg'));
    if (!matches.length) return null;

    let imgPath = path.join(dir, matches[0]);

    const enhanced = imgPath.replace('.jpg', '_enh.jpg');
    const magick   = spawnSync('convert', [imgPath, '-normalize', '-contrast', '-contrast', enhanced]);
    if (magick.status === 0 && fs.existsSync(enhanced)) {
      fs.unlinkSync(imgPath);
      imgPath = enhanced;
    }

    const data = fs.readFileSync(imgPath).toString('base64');
    fs.unlinkSync(imgPath);
    return data;
  } catch { return null; }
}

// ── KI erkennt Dokumentgrenzen ────────────────────────────────────────────────
async function detectBoundaries(filePath, pageCount) {
  console.log(`[DokuScan] 🔍 Erkenne Dokumentgrenzen in ${pageCount} Seiten…`);

  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const text = getPageText(filePath, i);
    pages.push({ page: i, text, hasText: text.length > 0, continuation: hasContinuationSignal(text) });
  }

  const totalTextLen = pages.reduce((s, p) => s + p.text.length, 0);
  const useImages    = totalTextLen < 50;

  // Vorfilter: Seiten mit Fortsetzungssignal können kein Dokumentstart sein
  const forcedContinuation = new Set(
    pages.filter(p => p.continuation).map(p => p.page)
  );

  let content;

  if (useImages) {
    console.log(`[DokuScan] 📷 Kein extrahierbarer Text – verwende Bildanalyse`);
    content = [];
    const MAX_IMGS = 20;
    for (const p of pages.slice(0, MAX_IMGS)) {
      const b64 = renderPageAsBase64(filePath, p.page);
      if (b64) {
        content.push({ type: 'text', text: `--- Seite ${p.page} ---` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      } else {
        content.push({ type: 'text', text: `--- Seite ${p.page}: (nicht renderbar) ---` });
      }
    }
    if (pageCount > MAX_IMGS) {
      content.push({ type: 'text', text: `(Seiten ${MAX_IMGS + 1}–${pageCount} nicht dargestellt)` });
    }
    content.push({ type: 'text', text:
      `Das ist ein eingescannter Dokumentenstapel mit ${pageCount} Seiten.\n\n` +
      `AUFGABE: Erkenne die Grenzen zwischen verschiedenen Dokumenten.\n\n` +
      `WICHTIGE REGELN – lies diese sorgfältig:\n` +
      `1. Ein mehrseitiges Dokument (Brief, Vertrag, Kontoauszug, Rechnung über mehrere Seiten) gehört ZUSAMMEN – trenne es NICHT.\n` +
      `2. Neue Dokument-Grenze NUR wenn: anderer Absender/Briefkopf, komplett anderes Thema, anderes Datum UND anderer Absender.\n` +
      `3. Folgeseiten (gleicher Briefkopf, "Seite 2 von 3", gleiche Rechnungsnummer) → KEIN neues Dokument.\n` +
      `4. Im Zweifel: Seiten ZUSAMMENLASSEN statt trennen.\n` +
      `5. Leere Trennseiten zwischen Dokumenten → ignorieren (zählen zum vorherigen Dokument).\n\n` +
      `Antworte NUR mit validem JSON: {"boundaries":[1,...]} – Seitenzahlen wo ein NEUES Dokument beginnt. Seite 1 immer enthalten.`
    });
  } else {
    const pagesSummary = pages.map(p => {
      const cont = p.continuation ? ' [FORTSETZUNG – kein neues Dokument]' : '';
      return `=== Seite ${p.page}${cont} ===\n${p.text || '(leer/kein Text)'}`;
    }).join('\n\n');

    content =
      `Du analysierst einen eingescannten Dokumentenstapel mit ${pageCount} Seiten.\n\n` +
      `AUFGABE: Erkenne die Grenzen zwischen verschiedenen Dokumenten.\n\n` +
      `WICHTIGE REGELN – lies diese sorgfältig:\n` +
      `1. Ein mehrseitiges Dokument (Brief, Vertrag, Kontoauszug, Rechnung über mehrere Seiten) gehört ZUSAMMEN – trenne es NICHT.\n` +
      `2. Neue Dokumentgrenze NUR bei: eindeutigem Wechsel von Absender UND Thema. Eines allein reicht nicht.\n` +
      `3. Folgeseiten erkennst du an: gleicher Rechnungs-/Vertragsnummer, "Seite X von Y", gleicher Anschrift, inhaltlicher Fortsetzung, Übertrag-Zeilen.\n` +
      `4. Anhänge (AGB, Produktblätter) die direkt zu einem Dokument gehören → NICHT trennen.\n` +
      `5. Im Zweifel: Seiten ZUSAMMENLASSEN. Lieber 1 Dokument zu viel als ein Dokument zerrissen.\n` +
      `6. Bereits markierte FORTSETZUNGS-Seiten sind definitiv kein neuer Dokumentstart.\n\n` +
      `SEITENINHALT:\n${pagesSummary}\n\n` +
      `Antworte NUR mit validem JSON: {"boundaries":[1,...]} – Seitenzahlen wo ein NEUES Dokument beginnt. Seite 1 immer enthalten.`;
  }

  const response = await withRetry(() => client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1024,
    messages:   [{ role: 'user', content }]
  }));

  const raw    = response.content[0].text.match(/\{[\s\S]*\}/)[0];
  const result = JSON.parse(raw);

  // Seiten mit Fortsetzungssignal können kein Dokumentstart sein
  const rawBoundaries = [...new Set([1, ...result.boundaries])]
    .filter(n => n >= 1 && n <= pageCount && !forcedContinuation.has(n))
    .sort((a, b) => a - b);

  // Plausibilitätsprüfung: mehr als die Hälfte 1-seitige Docs bei >6 Seiten → verdächtig
  const ranges = rawBoundaries.map((start, i) => ({
    start,
    end: i < rawBoundaries.length - 1 ? rawBoundaries[i + 1] - 1 : pageCount
  }));
  const singlePageCount = ranges.filter(r => r.end - r.start === 0).length;
  if (pageCount > 6 && singlePageCount > ranges.length * 0.6) {
    console.warn(`[DokuScan] ⚠️  Zu viele Einzelseiten-Dokumente (${singlePageCount}/${ranges.length}) – sende zur manuellen Prüfung`);
    return [{ start: 1, end: pageCount, suspicious: true }];
  }

  return ranges;
}

// ── PDF in Teilstücke aufteilen ───────────────────────────────────────────────
async function splitPDF(filePath, ranges) {
  const srcBytes = fs.readFileSync(filePath);
  const srcDoc   = await PDFDocument.load(srcBytes);
  const parts    = [];

  for (const { start, end } of ranges) {
    const newDoc   = await PDFDocument.create();
    const indices  = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
    const copied   = await newDoc.copyPages(srcDoc, indices);
    copied.forEach(p => newDoc.addPage(p));
    const bytes    = await newDoc.save();
    const tmpPath  = path.join(os.tmpdir(), `ds_split_${start}-${end}_${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, bytes);
    parts.push({ tmpPath, pageCount: end - start + 1 });
  }

  return parts;
}

// ── Ein einzelnes Dokument analysieren & archivieren ─────────────────────────
async function analyzeDocument(filePath) {
  const ext    = path.extname(filePath).toLowerCase();
  const prompt = `Analysiere dieses Dokument. Antworte NUR mit validem JSON (kein Markdown):
{"kategorie":"Rechnung|Vertrag|Kontoauszug|Versicherung|Brief|Steuer|Behoerde|Medizin|Sonstiges","datum":"YYYY-MM-DD oder null","absender":"Firmenname oder null","beschreibung":"max 5 Woerter","betrag":"Betrag mit Währung als String oder null","zusammenfassung":"1-2 Sätze auf Deutsch"}`;

  if (['.jpg','.jpeg','.png','.tiff','.tif','.webp'].includes(ext)) {
    const b64  = fs.readFileSync(filePath).toString('base64');
    const mime = ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/tiff';
    const res  = await client.messages.create({
      model: 'claude-opus-4-6', max_tokens: 512,
      messages: [{ role:'user', content: [{ type:'image', source:{ type:'base64', media_type:mime, data:b64 }}, { type:'text', text:prompt }] }]
    });
    return JSON.parse(res.content[0].text.match(/\{[\s\S]*\}/)[0]);
  }

  // PDF: Text extrahieren
  const text = (() => { try { return execSync(`pdftotext "${filePath}" -`, { encoding:'utf8' }).trim().substring(0,3000); } catch { return ''; } })();

  // Wenn kein Text vorhanden → sofort auf Bildanalyse umschalten
  const b64 = renderPageAsBase64(filePath, 1);

  let msgContent;
  if (b64) {
    msgContent = [
      { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:b64 } },
      { type:'text', text: text ? `${prompt}\n\nExtrahierter Text:\n${text}` : prompt }
    ];
  } else if (text) {
    msgContent = `${prompt}\n\nDokumenteninhalt:\n${text}`;
  } else {
    msgContent = `${prompt}\n\nDokumenteninhalt:\n(nicht lesbar)`;
  }

  const res = await withRetry(() => client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 512,
    messages: [{ role:'user', content: msgContent }]
  }));
  return JSON.parse(res.content[0].text.match(/\{[\s\S]*\}/)[0]);
}

async function archiveDocument(filePath, originalName, pageCount) {
  const analysis  = await analyzeDocument(filePath);
  const kategorie = KATEGORIEN.includes(analysis.kategorie) ? analysis.kategorie : 'Sonstiges';
  const ext       = path.extname(filePath);
  const datum     = analysis.datum || new Date().toISOString().split('T')[0];
  const abs       = sanitize(analysis.absender || 'Unbekannt');
  const desc      = sanitize(analysis.beschreibung || '');
  const filename  = `${datum}_${kategorie}_${abs}${desc?'_'+desc:''}${ext}`;

  const targetDir = path.join(ARCHIV, kategorie);
  fs.mkdirSync(targetDir, { recursive: true });

  let targetPath = path.join(targetDir, filename);
  let counter = 1;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(targetDir, filename.replace(ext, `_${counter}${ext}`));
    counter++;
  }

  fs.copyFileSync(filePath, targetPath);
  fs.unlinkSync(filePath);
  fs.writeFileSync(targetPath + '.meta.json', JSON.stringify({
    originalName,
    kategorie,
    datum:           analysis.datum          || null,
    absender:        analysis.absender       || null,
    betrag:          analysis.betrag         || null,
    zusammenfassung: analysis.zusammenfassung|| null,
    beschreibung:    analysis.beschreibung   || null,
    pages:           pageCount               || null,
    processedAt:     new Date().toISOString(),
  }, null, 2));

  statusState.processedToday++;
  saveStatus();

  console.log(`[DokuScan] ✅ → ${kategorie}/${path.basename(targetPath)}`);
  console.log(`           Absender: ${analysis.absender||'-'} | Datum: ${analysis.datum||'-'} | Betrag: ${analysis.betrag||'-'} | Seiten: ${pageCount||'?'}`);
}

// ── Hauptprozess ──────────────────────────────────────────────────────────────
async function processFile(filePath) {
  console.log(`[DokuScan] 📄 Neue Datei: ${path.basename(filePath)}`);
  await new Promise(r => setTimeout(r, 3000));

  const ext      = path.extname(filePath).toLowerCase();
  const origName = path.basename(filePath);

  statusState.currentFile = origName;
  saveStatus();

  try {
    if (ext === '.pdf') {
      const pageCount = getPageCount(filePath);
      console.log(`[DokuScan] 📑 Seiten: ${pageCount}`);

      if (pageCount > 1) {
        const ranges = await detectBoundaries(filePath, pageCount);
        console.log(`[DokuScan] 📂 ${ranges.length} Dokument(e) erkannt: ${ranges.map(r => `S.${r.start}-${r.end}`).join(', ')}`);

        // Verdächtiger Stack → in Pruefen-Ordner zur manuellen Sichtung
        if (ranges.length === 1 && ranges[0].suspicious) {
          const pruefen = path.join(ARCHIV, 'Pruefen');
          fs.mkdirSync(pruefen, { recursive: true });
          const dest = path.join(pruefen, origName);
          fs.copyFileSync(filePath, dest);
          fs.unlinkSync(filePath);
          fs.writeFileSync(dest + '.meta.json', JSON.stringify({
            originalName: origName, kategorie: 'Pruefen', pages: pageCount,
            hinweis: 'Automatische Trennung unsicher – bitte manuell prüfen',
            processedAt: new Date().toISOString()
          }, null, 2));
          console.log(`[DokuScan] 🔎 → Pruefen/${origName} (manuelle Prüfung nötig)`);
          statusState.processedToday++;
          saveStatus();
          return;
        }

        if (ranges.length > 1) {
          const parts = await splitPDF(filePath, ranges);
          fs.unlinkSync(filePath);
          for (const { tmpPath, pageCount: partPages } of parts) {
            await archiveDocument(tmpPath, origName, partPages);
          }
          return;
        }
      }

      await archiveDocument(filePath, origName, pageCount);
    } else {
      await archiveDocument(filePath, origName, null);
    }
  } catch (err) {
    logError(origName, err.message);
    statusState.errorCount++;
    saveStatus();
    const fallback = path.join(ARCHIV, 'Sonstiges');
    fs.mkdirSync(fallback, { recursive: true });
    try {
      fs.copyFileSync(filePath, path.join(fallback, origName));
      fs.unlinkSync(filePath);
    } catch {}
  } finally {
    statusState.currentFile = null;
    saveStatus();
  }
}

// ── Warteschlange (sequenziell, kein paralleles Rate-Limit-Problem) ───────────
const queue   = [];
let processing = false;

async function withRetry(fn, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429    = err.message?.includes('429') || err.status === 429;
      const isTimeout = err.message?.includes('timed out') || err.message?.includes('timeout');
      if ((is429 || isTimeout) && attempt < retries) {
        const wait = Math.pow(2, attempt + 2) * 1000;
        console.log(`[DokuScan] ⏳ Rate limit / Timeout – warte ${wait/1000}s (Versuch ${attempt+1}/${retries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

async function runQueue() {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    statusState.queueLength = queue.length;
    saveStatus();
    const filePath = queue.shift();
    await processFile(filePath).catch(err => {
      logError(path.basename(filePath), `Queue-Fehler: ${err.message}`);
      statusState.errorCount++;
      saveStatus();
    });
    statusState.queueLength = queue.length;
    saveStatus();
    if (queue.length > 0) await new Promise(r => setTimeout(r, 2000));
  }
  processing = false;
}

function enqueue(filePath) {
  queue.push(filePath);
  statusState.queueLength = queue.length;
  saveStatus();
  console.log(`[DokuScan] 📥 Eingereiht: ${path.basename(filePath)} (Queue: ${queue.length})`);
  runQueue();
}

// ── Start ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(EINGANG, { recursive: true });
fs.mkdirSync(ARCHIV,  { recursive: true });

const watcher = chokidar.watch(EINGANG, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }
});

watcher.on('add', enqueue);
console.log(`[DokuScan] 🚀 Bereit – überwache ${EINGANG}`);
console.log(`[DokuScan] 🤖 KI-Dokumentgrenzerkennung aktiv (sequenzielle Queue)`);
