#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const Anthropic = require('@anthropic-ai/sdk');
const { execSync } = require('child_process');
require('dotenv').config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EINGANG = process.env.SCAN_EINGANG || '/home/pi/Scanner/Eingang';
const ARCHIV  = process.env.SCAN_ARCHIV  || '/home/pi/Scanner/Archiv';

const KATEGORIEN = [
  'Rechnung', 'Vertrag', 'Kontoauszug', 'Versicherung',
  'Brief', 'Steuer', 'Behoerde', 'Medizin', 'Sonstiges'
];

function sanitize(str) {
  return (str || '').replace(/[^a-zA-Z0-9äöüÄÖÜß\-]/g, '_').replace(/_+/g, '_').substring(0, 40);
}

async function analyzeDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const prompt = `Analysiere dieses Dokument. Antworte NUR mit validem JSON (kein Markdown):
{"kategorie":"Rechnung|Vertrag|Kontoauszug|Versicherung|Brief|Steuer|Behoerde|Medizin|Sonstiges","datum":"YYYY-MM-DD oder null","absender":"Firmenname oder null","beschreibung":"max 5 Woerter"}`;

  if (['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.webp'].includes(ext)) {
    const imageData = fs.readFileSync(filePath).toString('base64');
    const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                    : ext === '.png'  ? 'image/png'
                    : ext === '.webp' ? 'image/webp'
                    : 'image/tiff';

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
          { type: 'text', text: prompt }
        ]
      }]
    });
    return JSON.parse(response.content[0].text.match(/\{[\s\S]*\}/)[0]);
  }

  // PDF → Text via pdftotext
  let textContent = '';
  try {
    textContent = execSync(`pdftotext "${filePath}" -`, { encoding: 'utf8' }).substring(0, 4000);
  } catch {
    textContent = '(PDF konnte nicht gelesen werden)';
  }

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `${prompt}\n\nDokumenteninhalt:\n${textContent}`
    }]
  });
  return JSON.parse(response.content[0].text.match(/\{[\s\S]*\}/)[0]);
}

function buildFilename(analysis, originalFile) {
  const ext   = path.extname(originalFile);
  const datum = analysis.datum || new Date().toISOString().split('T')[0];
  const kat   = KATEGORIEN.includes(analysis.kategorie) ? analysis.kategorie : 'Sonstiges';
  const abs   = sanitize(analysis.absender || 'Unbekannt');
  const desc  = sanitize(analysis.beschreibung || '');
  return `${datum}_${kat}_${abs}${desc ? '_' + desc : ''}${ext}`;
}

async function processFile(filePath) {
  console.log(`[DokuScan] 📄 Neue Datei: ${path.basename(filePath)}`);

  // Warten bis Datei vollständig geschrieben
  await new Promise(r => setTimeout(r, 3000));

  try {
    const analysis  = await analyzeDocument(filePath);
    const kategorie = KATEGORIEN.includes(analysis.kategorie) ? analysis.kategorie : 'Sonstiges';
    const filename  = buildFilename(analysis, filePath);

    const targetDir  = path.join(ARCHIV, kategorie);
    fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, filename);
    fs.renameSync(filePath, targetPath);

    console.log(`[DokuScan] ✅ → ${kategorie}/${filename}`);
    console.log(`           Absender: ${analysis.absender || '-'} | Datum: ${analysis.datum || '-'}`);
  } catch (err) {
    console.error(`[DokuScan] ❌ Fehler: ${err.message}`);
    const fallback = path.join(ARCHIV, 'Sonstiges');
    fs.mkdirSync(fallback, { recursive: true });
    try { fs.renameSync(filePath, path.join(fallback, path.basename(filePath))); } catch {}
  }
}

// Ordner sicherstellen
fs.mkdirSync(EINGANG, { recursive: true });
fs.mkdirSync(ARCHIV,  { recursive: true });

// Watcher starten
const watcher = chokidar.watch(EINGANG, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }
});

watcher.on('add', processFile);
console.log(`[DokuScan] 🚀 Bereit – überwache ${EINGANG}`);
