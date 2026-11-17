# Hàm dùng chung cho script test (source file này).

# In đường dẫn ffmpeg: ffmpeg trong PATH, nếu không có thì binary của @ffmpeg-installer
# trong src/transcode-worker/node_modules (có sau khi npm install ở worker).
find_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1; then
    command -v ffmpeg
    return
  fi
  local root bundled
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  bundled=$(ls "$root"/src/transcode-worker/node_modules/@ffmpeg-installer/*/ffmpeg 2>/dev/null | head -1)
  if [[ -x $bundled ]]; then
    echo "$bundled"
    return
  fi
  echo "ffmpeg not found: install it or run npm install in src/transcode-worker" >&2
  return 1
}
