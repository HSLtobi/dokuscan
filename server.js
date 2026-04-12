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
const KATEGORIEN = ['Rechnung','Vertrag','Kontoauszug','Versicherung','Brief','Steuer','Behoerde','Medizin','Sonstiges'];

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
      .replace(/\s+/g, ' ').trim().substring(0, 600);
  } catch { return ''; }
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

    // Kontrast verbessern mit ImageMagick falls verfügbar (hilft bei blassen Scans)
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

  // Text aller Seiten sammeln
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const text = getPageText(filePath, i);
    pages.push({ page: i, text, hasText: text.length > 40 });
  }

  const avgTextLen = pages.reduce((s,p) => s + p.text.length, 0) / pageCount;
  const useImages  = avgTextLen < 50; // Fast kein Text → Bild-basierte Analyse

  let content;

  if (useImages) {
    // Seiten als Bilder senden (max. 20 Bilder auf einmal, sonst in Blöcken)
    console.log(`[DokuScan] 📷 Wenig Text – verwende Bildanalyse für Grenzerkennung`);
    content = [];
    const MAX_IMGS = 20;
    const pagesToSend = pages.slice(0, MAX_IMGS);

    for (const p of pagesToSend) {
      const b64 = renderPageAsBase64(filePath, p.page);
      if (b64) {
        content.push({ type: 'text', text: `--- Seite ${p.page} ---` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
      } else {
        content.push({ type: 'text', text: `--- Seite ${p.page}: (nicht renderbar) ---` });
      }
    }
    if (pageCount > MAX_IMGS) {
      content.push({ type: 'text', text: `(Seiten ${MAX_IMGS+1}–${pageCount} nicht dargestellt, bitte schätzen)` });
    }
    content.push({ type: 'text', text:
      `Das ist ein Scan-Stapel mit ${pageCount} Seiten und ${pageCount > MAX_IMGS ? 'mindestens ' : ''}mehreren verschiedenen Dokumenten.\n` +
      `Erkenne wo jedes neue Dokument beginnt.\n` +
      `Antworte NUR mit JSON: {"boundaries":[1,3,5,...]} – Seitenzahlen wo ein neues Dokument anfängt. Seite 1 ist immer dabei.`
    });
  } else {
    // Text-basierte Analyse
    const pagesSummary = pages.map(p =>
      `=== Seite ${p.page} ===\n${p.text || '(leer)'}`
    ).join('\n\n');

    content = `Du analysierst einen Scan-Stapel mit ${pageCount} Seiten, der mehrere verschiedene Dokumente enthält.\n\n` +
      `Erkenne anhand von Wechseln in Absender, Briefkopf, Datum, Dokumenttyp und Formatierung wo neue Dokumente beginnen.\n\n` +
      `${pagesSummary}\n\n` +
      `Antworte NUR mit validem JSON: {"boundaries":[1,3,5,...]} – Seitenzahlen wo ein neues Dokument anfängt. Seite 1 ist immer dabei.`;
  }

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 512,
    messages:   [{ role: 'user', content }]
  });

  const raw        = response.content[0].text.match(/\{[\s\S]*\}/)[0];
  const result     = JSON.parse(raw);
  const boundaries = [...new Set([1, ...result.boundaries])].filter(n => n >= 1 && n <= pageCount).sort((a,b) => a-b);

  // Grenzen → Seitenbereiche
  return boundaries.map((start, i) => ({
    start,
    end: i < boundaries.length - 1 ? boundaries[i+1] - 1 : pageCount
  }));
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
    parts.push(tmpPath);
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

  // PDF: zuerst Bild der ersten Seite + extrahierter Text
  const text = (() => { try { return execSync(`pdftotext "${filePath}" -`, { encoding:'utf8' }).substring(0,3000); } catch { return ''; } })();
  const b64  = renderPageAsBase64(filePath, 1);

  let msgContent;
  if (b64) {
    msgContent = [
      { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:b64 } },
      { type:'text', text: text ? `${prompt}\n\nExtrahierter Text:\n${text}` : prompt }
    ];
  } else {
    msgContent = `${prompt}\n\nDokumenteninhalt:\n${text || '(nicht lesbar)'}`;
  }

  const res = await withRetry(() => client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 512,
    messages: [{ role:'user', content: msgContent }]
  }));
  return JSON.parse(res.content[0].text.match(/\{[\s\S]*\}/)[0]);
}

async function archiveDocument(filePath, originalName) {
  const analysis  = await analyzeDocument(filePath);
  const kategorie = KATEGORIEN.includes(analysis.kategorie) ? analysis.kategorie : 'Sonstiges';
  const ext       = path.extname(filePath);
  const datum     = analysis.datum || new Date().toISOString().split('T')[0];
  const abs       = sanitize(analysis.absender || 'Unbekannt');
  const desc      = sanitize(analysis.beschreibung || '');
  const filename  = `${datum}_${kategorie}_${abs}${desc?'_'+desc:''}${ext}`;

  const targetDir = path.join(ARCHIV, kategorie);
  fs.mkdirSync(targetDir, { recursive: true });

  // Eindeutiger Name falls Konflikt
  let targetPath = path.join(targetDir, filename);
  let counter = 1;
  while (fs.existsSync(targetPath)) {
    targetPath = path.join(targetDir, filename.replace(ext, `_${counter}${ext}`));
    counter++;
  }

  // Cross-device safe: copy + delete statt rename
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
    processedAt:     new Date().toISOString(),
  }, null, 2));

  console.log(`[DokuScan] ✅ → ${kategorie}/${path.basename(targetPath)}`);
  console.log(`           Absender: ${analysis.absender||'-'} | Datum: ${analysis.datum||'-'} | Betrag: ${analysis.betrag||'-'}`);
}

// ── Hauptprozess ──────────────────────────────────────────────────────────────
async function processFile(filePath) {
  console.log(`[DokuScan] 📄 Neue Datei: ${path.basename(filePath)}`);
  await new Promise(r => setTimeout(r, 3000)); // Warten bis vollständig geschrieben

  const ext      = path.extname(filePath).toLowerCase();
  const origName = path.basename(filePath);

  try {
    // Nur PDFs werden auf mehrere Dokumente geprüft
    if (ext === '.pdf') {
      const pageCount = getPageCount(filePath);
      console.log(`[DokuScan] 📑 Seiten: ${pageCount}`);

      if (pageCount > 1) {
        // KI-Grenzerkennung
        const ranges = await detectBoundaries(filePath, pageCount);
        console.log(`[DokuScan] 📂 ${ranges.length} Dokument(e) erkannt: ${ranges.map(r => `S.${r.start}-${r.end}`).join(', ')}`);

        if (ranges.length > 1) {
          // Aufteilen & jeden Teil einzeln archivieren
          const parts = await splitPDF(filePath, ranges);
          fs.unlinkSync(filePath); // Original löschen
          for (const part of parts) {
            await archiveDocument(part, origName);
          }
          return;
        }
      }
    }

    // Einzeldokument (Bild oder einseitiges PDF)
    await archiveDocument(filePath, origName);

  } catch (err) {
    console.error(`[DokuScan] ❌ Fehler: ${err.message}`);
    const fallback = path.join(ARCHIV, 'Sonstiges');
    fs.mkdirSync(fallback, { recursive: true });
    try { fs.renameSync(filePath, path.join(fallback, origName)); } catch {}
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
      const is429 = err.message?.includes('429') || err.status === 429;
      const isTimeout = err.message?.includes('timed out') || err.message?.includes('timeout');
      if ((is429 || isTimeout) && attempt < retries) {
        const wait = Math.pow(2, attempt + 2) * 1000; // 4s, 8s, 16s, 32s
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
    const filePath = queue.shift();
    await processFile(filePath).catch(err =>
      console.error(`[DokuScan] ❌ Queue-Fehler: ${err.message}`)
    );
    // Kurze Pause zwischen Dokumenten um Rate Limit zu schonen
    if (queue.length > 0) await new Promise(r => setTimeout(r, 2000));
  }
  processing = false;
}

function enqueue(filePath) {
  queue.push(filePath);
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

