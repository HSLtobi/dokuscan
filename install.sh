#!/bin/bash
set -e

DOKUSCAN_DIR="/home/pi/dokuscan"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║    DokuScan Installation startet     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1) System-Dependencies
echo "[1/6] Installiere System-Pakete..."
apt-get update -qq
apt-get install -y poppler-utils samba curl imagemagick ghostscript tesseract-ocr tesseract-ocr-deu

# Node.js prüfen (sollte v22 sein laut Chat)
node --version | grep -q "v2" || {
  echo "Node.js nicht gefunden, installiere v20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
}

# 2) Ordnerstruktur
echo "[2/6] Erstelle Ordnerstruktur..."
mkdir -p /home/pi/Scanner/Eingang
mkdir -p /home/pi/Scanner/Archiv/{Rechnung,Vertrag,Kontoauszug,Versicherung,Brief,Steuer,Behoerde,Medizin,Sonstiges}
chown -R pi:pi /home/pi/Scanner

# 3) App installieren
echo "[3/6] Installiere DokuScan..."
mkdir -p "$DOKUSCAN_DIR"
cp server.js package.json "$DOKUSCAN_DIR/"
chown -R pi:pi "$DOKUSCAN_DIR"

cd "$DOKUSCAN_DIR"
sudo -u pi npm install --omit=dev

# 4) .env mit API Key
echo "[4/6] Konfiguriere API Key..."
if [ -z "$ANTHROPIC_API_KEY" ]; then
  read -rp "Anthropic API Key (sk-ant-...): " ANTHROPIC_API_KEY
fi
# Web-UI Login (Basic Auth): aus Umgebung oder Benutzer abfragen / Passwort generieren
if [ -z "$DOKUSCAN_USER" ]; then
  read -rp "Web-UI Benutzername [admin]: " DOKUSCAN_USER
  DOKUSCAN_USER="${DOKUSCAN_USER:-admin}"
fi
DOKUSCAN_PASS="${DOKUSCAN_PASS:-$(openssl rand -base64 18)}"
cat > "$DOKUSCAN_DIR/.env" << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
SCAN_EINGANG=/home/pi/Scanner/Eingang
SCAN_ARCHIV=/home/pi/Scanner/Archiv
DOKUSCAN_USER=${DOKUSCAN_USER}
DOKUSCAN_PASS=${DOKUSCAN_PASS}
# Optional: erkannte Vertraege automatisch an Vertragsmanagement pushen
# CONTRACT_MANAGER_URL=https://contracts.boettcher.vip
# CONTRACT_MANAGER_INTAKE_KEY=...
EOF
chmod 600 "$DOKUSCAN_DIR/.env"
chown pi:pi "$DOKUSCAN_DIR/.env"

# 5) Samba (SMB-Freigabe)
echo "[5/6] Richte SMB-Freigabe ein..."
export SMB_PASS="${SMB_PASS:-$(openssl rand -base64 18)}"
bash smb-setup.sh

# 6) systemd Service
echo "[6/6] Richte systemd Service ein..."
cat > /etc/systemd/system/dokuscan.service << EOF
[Unit]
Description=DokuScan – KI Dokumentenscanner
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=${DOKUSCAN_DIR}
EnvironmentFile=${DOKUSCAN_DIR}/.env
ExecStart=/usr/bin/node ${DOKUSCAN_DIR}/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dokuscan
systemctl start dokuscan

sleep 2

PI_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🎉 DokuScan erfolgreich installiert!   ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Scanner-Eingang:                        ║"
echo "║  \\\\${PI_IP}\\Scanner                      "
echo "║  SMB-User: scanner / PW: ${SMB_PASS}"
echo "║  Web-UI:   ${DOKUSCAN_USER} / PW: ${DOKUSCAN_PASS}"
echo "║  (Passwörter stehen NUR hier und in .env)"
echo "╠══════════════════════════════════════════╣"
echo "║  Logs: journalctl -u dokuscan -f         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Nächster Schritt: ScanSnap Home → Profil → Netzwerkordner"
echo "Pfad: \\\\${PI_IP}\\Scanner"
