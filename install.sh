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
apt-get install -y poppler-utils samba curl

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
cat > "$DOKUSCAN_DIR/.env" << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
SCAN_EINGANG=/home/pi/Scanner/Eingang
SCAN_ARCHIV=/home/pi/Scanner/Archiv
EOF
chmod 600 "$DOKUSCAN_DIR/.env"
chown pi:pi "$DOKUSCAN_DIR/.env"

# 5) Samba (SMB-Freigabe)
echo "[5/6] Richte SMB-Freigabe ein..."
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
echo "║  User: scanner / PW: dokuscan123         ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Logs: journalctl -u dokuscan -f         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Nächster Schritt: ScanSnap Home → Profil → Netzwerkordner"
echo "Pfad: \\\\${PI_IP}\\Scanner"
