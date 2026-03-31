#!/bin/bash
set -e

DOKUSCAN_DIR="/home/pi/dokuscan"
ENV_FILE="$DOKUSCAN_DIR/.env"

echo "[DokuScan] Systemd Service einrichten..."

# API Key abfragen falls nicht gesetzt
if [ -z "$ANTHROPIC_API_KEY" ]; then
  read -rp "Anthropic API Key (sk-ant-...): " ANTHROPIC_API_KEY
fi

# .env Datei erstellen
cat > "$ENV_FILE" << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
SCAN_EINGANG=/home/pi/Scanner/Eingang
SCAN_ARCHIV=/home/pi/Scanner/Archiv
EOF
chmod 600 "$ENV_FILE"
chown pi:pi "$ENV_FILE"

# systemd Service anlegen
cat > /etc/systemd/system/dokuscan.service << EOF
[Unit]
Description=DokuScan – KI Dokumentenscanner
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=${DOKUSCAN_DIR}
EnvironmentFile=${ENV_FILE}
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
systemctl status dokuscan --no-pager

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  DokuScan Service läuft!             ║"
echo "╠══════════════════════════════════════╣"
echo "║  Status:  systemctl status dokuscan  ║"
echo "║  Logs:    journalctl -u dokuscan -f  ║"
echo "║  Stop:    systemctl stop dokuscan    ║"
echo "╚══════════════════════════════════════╝"
