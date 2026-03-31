#!/usr/bin/env node
'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
require('dotenv').config();

const app    = express();
const PORT   = process.env.WEB_PORT  || 3001;
const ARCHIV = process.env.SCAN_ARCHIV || '/home/pi/Scanner/Archiv';
const EINGANG = process.env.SCAN_EINGANG || '/home/pi/Scanner/Eingang';

app.use(express.static(path.join(__dirname, 'public')));

// API: Alle Dokumente
app.get('/api/documents', (req, res) => {
  const docs = [];
  if (!fs.existsSync(ARCHIV)) return res.json([]);

  for (const kat of fs.readdirSync(ARCHIV)) {
    const katDir = path.join(ARCHIV, kat);
    if (!fs.statSync(katDir).isDirectory()) continue;
    for (const file of fs.readdirSync(katDir)) {
      if (file.startsWith('.') || file.endsWith('.meta.json')) continue;
      const filePath = path.join(katDir, file);
      const stat = fs.statSync(filePath);
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);

      // Metadaten aus .meta.json lesen
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(filePath + '.meta.json', 'utf8')); } catch {}

      docs.push({
        id:             Buffer.from(path.join(kat, file)).toString('base64'),
        name:           file,
        kategorie:      kat,
        datum:          meta.datum          || (dateMatch ? dateMatch[1] : null),
        absender:       meta.absender       || null,
        betrag:         meta.betrag         || null,
        zusammenfassung:meta.zusammenfassung|| null,
        size:           stat.size,
        modified:       stat.mtime.toISOString(),
        path:           path.join(kat, file)
      });
    }
  }
  docs.sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  res.json(docs);
});

// API: Eingang (ausstehend)
app.get('/api/pending', (req, res) => {
  if (!fs.existsSync(EINGANG)) return res.json([]);
  const files = fs.readdirSync(EINGANG).filter(f => !f.startsWith('.'));
  res.json(files);
});

// API: Datei herunterladen
app.get('/api/download/:id', (req, res) => {
  try {
    const rel  = Buffer.from(req.params.id, 'base64').toString();
    const full = path.join(ARCHIV, rel);
    // Sicherheitscheck: kein Path-Traversal
    if (!full.startsWith(ARCHIV)) return res.status(403).send('Verboten');
    if (!fs.existsSync(full))     return res.status(404).send('Nicht gefunden');
    res.download(full);
  } catch { res.status(400).send('Ungültige ID'); }
});

// API: Status
app.get('/api/status', (req, res) => {
  const { execSync } = require('child_process');
  try {
    const out = execSync('systemctl is-active dokuscan', { encoding: 'utf8' }).trim();
    res.json({ scanner: out });
  } catch {
    res.json({ scanner: 'inactive' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[DokuScan Web] 🌐 http://0.0.0.0:${PORT}  →  http://dokubt.local:${PORT}`);
});
