#!/data/data/com.termux/files/usr/bin/bash
# ============================================
# AI Comic Creator - Termux Server Script
# ============================================
# This script sets up and runs the PWA server
# optimized for Termux on Android devices.
#
# Usage:
#   chmod +x server.sh
#   ./server.sh
#
# Or with a custom port:
#   PORT=3000 ./server.sh
# ============================================

set -e

PORT="${PORT:-8080}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=================================="
echo "  AI Comic Creator PWA Server"
echo "=================================="
echo ""

# Check and install dependencies
check_dep() {
  if ! command -v "$1" &> /dev/null; then
    echo "[*] Installing $1..."
    pkg install -y "$1" 2>/dev/null || apt install -y "$1" 2>/dev/null
  fi
}

# Generate PNG icons if they don't exist
generate_icons() {
  if [ ! -f "$DIR/icons/icon-192.png" ]; then
    echo "[*] Generating placeholder PNG icons..."
    # Create minimal valid PNG files as placeholders
    # (Users can replace with proper icons or use generate-icons.html in a browser)
    if command -v python3 &> /dev/null; then
      python3 -c "
import struct, zlib
def make_png(size, path):
    # Minimal purple square PNG
    raw = b''
    for y in range(size):
        raw += b'\\x00'  # filter none
        for x in range(size):
            r = int(124 + (132 * x / size))
            g = int(58 + (74 * x / size))
            b = int(237 + (15 * x / size))
            raw += bytes([min(r,255), min(g,255), min(b,255), 255])
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\\x89PNG\\r\\n\\x1a\\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(raw)))
        f.write(chunk(b'IEND', b''))
make_png(192, '$DIR/icons/icon-192.png')
make_png(512, '$DIR/icons/icon-512.png')
print('[+] Icons generated')
"
    else
      echo "[!] Python3 not available. Icons will use SVG fallback."
      echo "[!] Open generate-icons.html in a browser to create PNG icons."
    fi
  fi
}

generate_icons

# Try different HTTP servers in order of preference
echo "[*] Starting server on port $PORT..."
echo "[*] Open in your browser: http://localhost:$PORT"
echo "[*] On your device: http://127.0.0.1:$PORT"
echo ""
echo "[*] To install as PWA:"
echo "    1. Open the URL above in Chrome/Brave"
echo "    2. Tap the menu (three dots)"
echo "    3. Select 'Install app' or 'Add to Home screen'"
echo ""
echo "Press Ctrl+C to stop the server."
echo "=================================="
echo ""

cd "$DIR"

# Try python3 first (most reliable in Termux)
if command -v python3 &> /dev/null; then
  echo "[+] Using Python HTTP server"
  python3 -m http.server "$PORT" --bind 0.0.0.0
elif command -v python &> /dev/null; then
  echo "[+] Using Python 2 HTTP server"
  python -m SimpleHTTPServer "$PORT"
elif command -v npx &> /dev/null; then
  echo "[+] Using npx serve"
  npx -y serve -s -l "$PORT"
elif command -v php &> /dev/null; then
  echo "[+] Using PHP built-in server"
  php -S "0.0.0.0:$PORT"
elif command -v busybox &> /dev/null; then
  echo "[+] Using busybox httpd"
  busybox httpd -f -p "$PORT" -h "$DIR"
else
  echo "[!] No HTTP server found. Installing python..."
  pkg install -y python 2>/dev/null || apt install -y python3 2>/dev/null
  python3 -m http.server "$PORT" --bind 0.0.0.0
fi
