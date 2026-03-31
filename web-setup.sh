#!/bin/bash
set -e

DOKUSCAN_DIR="/home/pi/dokuscan"

echo "[DokuScan Web] Installiere express..."
cd "$DOKUSCAN_DIR"
sudo -u pi npm install --omit=dev

echo "[DokuScan Web] Kopiere Web-Dateien..."
cp web-server.js "$DOKUSCAN_DIR/"
cp -r public "$DOKUSCAN_DIR/"
chown -R pi:pi "$DOKUSCAN_DIR"

echo "[DokuScan Web] WEB_PORT zur .env hinzufügen..."
grep -q WEB_PORT "$DOKUSCAN_DIR/.env" || echo "WEB_PORT=3001" >> "$DOKUSCAN_DIR/.env"

echo "[DokuScan Web] Richte systemd Service ein..."
cat > /etc/systemd/system/dokuscan-web.service << 'EOF'
[Unit]
Description=DokuScan Web UI
After=network.target dokuscan.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/dokuscan
EnvironmentFile=/home/pi/dokuscan/.env
ExecStart=/usr/bin/node /home/pi/dokuscan/web-server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable dokuscan-web
systemctl restart dokuscan-web
sleep 2
systemctl status dokuscan-web --no-pager

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   DokuScan Web läuft auf Port 3001!      ║"
echo "╠══════════════════════════════════════════╣"
echo "║  http://$(hostname -I | awk '{print $1}'):3001"
echo "║  http://dokubt.local:3001                ║"
echo "╚══════════════════════════════════════════╝"
