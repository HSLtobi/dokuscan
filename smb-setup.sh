#!/bin/bash
set -e

SMB_USER="scanner"
SMB_PASS="dokuscan123"
SHARE_DIR="/home/pi/Scanner"

echo "[DokuScan] Installiere Samba..."
apt-get update -qq
apt-get install -y samba

echo "[DokuScan] Lege Ordner an..."
mkdir -p "$SHARE_DIR/Eingang" "$SHARE_DIR/Archiv"
chown -R pi:pi "$SHARE_DIR"
chmod -R 775 "$SHARE_DIR"

echo "[DokuScan] Erstelle SMB-Benutzer..."
(echo "$SMB_PASS"; echo "$SMB_PASS") | smbpasswd -s -a "$SMB_USER" 2>/dev/null || true
useradd -M -s /sbin/nologin "$SMB_USER" 2>/dev/null || true
(echo "$SMB_PASS"; echo "$SMB_PASS") | smbpasswd -s -a "$SMB_USER"

echo "[DokuScan] Konfiguriere Samba..."
cat >> /etc/samba/smb.conf << 'EOF'

[Scanner]
   path = /home/pi/Scanner
   browsable = yes
   writable = yes
   valid users = scanner
   create mask = 0664
   directory mask = 0775
   force user = pi
EOF

echo "[DokuScan] Starte Samba..."
systemctl enable smbd nmbd
systemctl restart smbd nmbd

PI_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "╔══════════════════════════════════════╗"
echo "║  SMB-Freigabe eingerichtet!          ║"
echo "╠══════════════════════════════════════╣"
echo "║  Netzwerkpfad: \\\\${PI_IP}\\Scanner"
echo "║  Benutzer:     ${SMB_USER}"
echo "║  Passwort:     ${SMB_PASS}"
echo "╚══════════════════════════════════════╝"
echo ""
echo "ScanSnap Home: Profil → Speicherziel → Netzwerkordner"
echo "Pfad: \\\\${PI_IP}\\Scanner"
