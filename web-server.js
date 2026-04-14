#!/usr/bin/env node
'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const archiver = require('archiver');
require('dotenv').config();

const app     = express();
const PORT    = process.env.WEB_PORT   || 3001;
const ARCHIV  = process.env.SCAN_ARCHIV  || '/home/pi/Scanner/Archiv';
const EINGANG = process.env.SCAN_EINGANG || '/home/pi/Scanner/Eingang';

const LOG_DIR     = path.join(__dirname, 'logs');
const ERROR_LOG   = path.join(LOG_DIR, 'error.log');
const STATUS_FILE = path.join(LOG_DIR, 'status.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer: Uploads direkt in den Scanner-Eingang
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { fs.mkdirSync(EINGANG, { recursive: true }); cb(null, EINGANG); },
    filename:    (req, file, cb) => cb(null, file.originalname),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf','.jpg','.jpeg','.png','.tiff','.tif','.webp'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function safeAbs(rel) {
  const full = path.resolve(path.join(ARCHIV, rel));
  if (!full.startsWith(path.resolve(ARCHIV))) throw new Error('Path traversal');
  return full;
}

function readMeta(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath + '.meta.json', 'utf8')); } catch { return {}; }
}

function docFromFile(kat, file) {
  const filePath  = path.join(ARCHIV, kat, file);
  const stat      = fs.statSync(filePath);
  const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
  const meta      = readMeta(filePath);
  return {
    id:             Buffer.from(path.join(kat, file)).toString('base64'),
    name:           file,
    kategorie:      kat,
    datum:          meta.datum           || (dateMatch ? dateMatch[1] : null),
    absender:       meta.absender        || null,
    betrag:         meta.betrag          || null,
    zusammenfassung:meta.zusammenfassung || null,
    pages:          meta.pages           || null,
    size:           stat.size,
    modified:       stat.mtime.toISOString(),
    path:           path.join(kat, file)
  };
}

// ── API: Alle Dokumente ───────────────────────────────────────────────────────
app.get('/api/documents', (req, res) => {
  const docs = [];
  if (!fs.existsSync(ARCHIV)) return res.json([]);
  for (const kat of fs.readdirSync(ARCHIV)) {
    const katDir = path.join(ARCHIV, kat);
    if (!fs.statSync(katDir).isDirectory()) continue;
    for (const file of fs.readdirSync(katDir)) {
      if (file.startsWith('.') || file.endsWith('.meta.json')) continue;
      try { docs.push(docFromFile(kat, file)); } catch {}
    }
  }
  docs.sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  res.json(docs);
});

// ── API: Eingang ──────────────────────────────────────────────────────────────
app.get('/api/pending', (req, res) => {
  if (!fs.existsSync(EINGANG)) return res.json([]);
  res.json(fs.readdirSync(EINGANG).filter(f => !f.startsWith('.')));
});

// ── API: Upload ───────────────────────────────────────────────────────────────
app.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Keine Dateien' });
  res.json({ uploaded: req.files.map(f => f.originalname) });
});

// ── API: Download einzelne Datei ──────────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
  try {
    const rel  = Buffer.from(req.params.id, 'base64').toString();
    const full = safeAbs(rel);
    if (!fs.existsSync(full)) return res.status(404).send('Nicht gefunden');
    res.download(full);
  } catch { res.status(400).send('Ungültige ID'); }
});

// ── API: Vorschau einzelne Datei (inline im Browser) ─────────────────────────
app.get('/api/preview/:id', (req, res) => {
  try {
    const rel  = Buffer.from(req.params.id, 'base64').toString();
    const full = safeAbs(rel);
    if (!fs.existsSync(full)) return res.status(404).send('Nicht gefunden');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(full).pipe(res);
  } catch { res.status(400).send('Ungültige ID'); }
});

// ── API: ZIP-Export ───────────────────────────────────────────────────────────
app.get('/api/export-zip', (req, res) => {
  const filterKat  = req.query.kat  || '';
  const filterYear = req.query.year || '';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="DokuScan_${new Date().toISOString().split('T')[0]}.zip"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(res);

  if (fs.existsSync(ARCHIV)) {
    for (const kat of fs.readdirSync(ARCHIV)) {
      if (filterKat && kat !== filterKat) continue;
      const katDir = path.join(ARCHIV, kat);
      if (!fs.statSync(katDir).isDirectory()) continue;
      for (const file of fs.readdirSync(katDir)) {
        if (file.startsWith('.') || file.endsWith('.meta.json')) continue;
        if (filterYear && !file.startsWith(filterYear)) continue;
        archive.file(path.join(katDir, file), { name: path.join(kat, file) });
      }
    }
  }
  archive.finalize();
});

// ── API: Umbenennen ───────────────────────────────────────────────────────────
app.patch('/api/rename/:id', (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName || newName.includes('/') || newName.includes('..'))
      return res.status(400).json({ error: 'Ungültiger Name' });

    const rel     = Buffer.from(req.params.id, 'base64').toString();
    const oldFull = safeAbs(rel);
    const kat     = path.dirname(rel);
    const newFull = safeAbs(path.join(kat, newName));

    if (!fs.existsSync(oldFull)) return res.status(404).json({ error: 'Nicht gefunden' });
    fs.renameSync(oldFull, newFull);

    const oldMeta = oldFull + '.meta.json';
    const newMeta = newFull + '.meta.json';
    if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, newMeta);

    res.json(docFromFile(kat, newName));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Kat ändern ───────────────────────────────────────────────────────────
app.patch('/api/kategorize/:id', (req, res) => {
  try {
    const { newKat } = req.body;
    const validKats  = ['Rechnung','Vertrag','Kontoauszug','Versicherung','Brief','Steuer','Behoerde','Medizin','Sonstiges'];
    if (!validKats.includes(newKat)) return res.status(400).json({ error: 'Ungültige Kategorie' });

    const rel     = Buffer.from(req.params.id, 'base64').toString();
    const oldFull = safeAbs(rel);
    const file    = path.basename(rel);
    const newDir  = path.join(ARCHIV, newKat);
    fs.mkdirSync(newDir, { recursive: true });
    const newFull = path.join(newDir, file);

    fs.renameSync(oldFull, newFull);
    const oldMeta = oldFull + '.meta.json';
    const newMeta = newFull + '.meta.json';
    if (fs.existsSync(oldMeta)) {
      const meta = readMeta(oldFull);
      meta.kategorie = newKat;
      fs.writeFileSync(newMeta, JSON.stringify(meta, null, 2));
      fs.unlinkSync(oldMeta);
    }

    res.json(docFromFile(newKat, file));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Scanner-Status (Queue + aktuelles Dokument) ─────────────────────────
app.get('/api/status', (req, res) => {
  const { execSync } = require('child_process');
  let scannerActive = false;
  try {
    const out = execSync('systemctl is-active dokuscan', { encoding: 'utf8' }).trim();
    scannerActive = out === 'active';
  } catch {}

  let queueStatus = { queueLength: 0, currentFile: null, errorCount: 0, processedToday: 0 };
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf8');
    const saved = JSON.parse(raw);
    const today = new Date().toISOString().split('T')[0];
    queueStatus = {
      queueLength:    saved.queueLength    || 0,
      currentFile:    saved.currentFile    || null,
      errorCount:     saved.date === today ? (saved.errorCount     || 0) : 0,
      processedToday: saved.date === today ? (saved.processedToday || 0) : 0,
    };
  } catch {}

  res.json({ scanner: scannerActive ? 'active' : 'inactive', ...queueStatus });
});

// ── API: Fehler-Log (letzte 100 Zeilen) ──────────────────────────────────────
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(ERROR_LOG)) return res.json({ lines: [] });
    const content = fs.readFileSync(ERROR_LOG, 'utf8');
    const lines   = content.split('\n').filter(l => l.trim()).slice(-100);
    res.json({ lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Statistiken ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const stats = { total: 0, byKategorie: {}, processedToday: 0, errorCount: 0 };

  if (fs.existsSync(ARCHIV)) {
    for (const kat of fs.readdirSync(ARCHIV)) {
      const katDir = path.join(ARCHIV, kat);
      if (!fs.statSync(katDir).isDirectory()) continue;
      const files = fs.readdirSync(katDir).filter(f => !f.startsWith('.') && !f.endsWith('.meta.json'));
      if (files.length > 0) {
        stats.byKategorie[kat] = files.length;
        stats.total += files.length;
      }
    }
  }

  try {
    const raw   = fs.readFileSync(STATUS_FILE, 'utf8');
    const saved = JSON.parse(raw);
    const today = new Date().toISOString().split('T')[0];
    if (saved.date === today) {
      stats.processedToday = saved.processedToday || 0;
      stats.errorCount     = saved.errorCount     || 0;
    }
  } catch {}

  res.json(stats);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[DokuScan Web] 🌐 http://0.0.0.0:${PORT}  →  http://dokubt.local:${PORT}`);
});
