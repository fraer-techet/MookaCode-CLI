#!/usr/bin/env bash
# MookaCode installer for Linux and macOS.
#
# Downloads the release bundle, verifies its SHA-256 checksum and installs a
# `mookacode` launcher. No sudo, no Rust, no build tools — only Node.js 20.11+.
#
#   curl -fsSL https://raw.githubusercontent.com/fraer-techet/mookacode/main/install.sh | bash
#
# Environment:
#   MOOKACODE_VERSION      release tag to install (default: latest)
#   MOOKACODE_REPO         owner/repo (default: fraer-techet/mookacode)
#   MOOKACODE_INSTALL_DIR  where the bundle lives (default: ~/.local/share/mookacode)
#   MOOKACODE_BIN_DIR      where the launcher goes (default: ~/.local/bin)

set -euo pipefail

REPO="${MOOKACODE_REPO:-fraer-techet/mookacode}"
VERSION="${MOOKACODE_VERSION:-latest}"
INSTALL_DIR="${MOOKACODE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mookacode}"
BIN_DIR="${MOOKACODE_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is required (20.11 or newer). Install it from https://nodejs.org and retry."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
node_minor="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 11 ]; }; then
  fail "Node.js 20.11+ is required, found $(node -v)."
fi

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
  fetch_to() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
  fetch_to() { wget -qO "$2" "$1"; }
else
  fail "curl or wget is required."
fi

if [ "$VERSION" = "latest" ]; then
  latest_json="$(fetch "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  VERSION="$(printf '%s' "$latest_json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  case "$VERSION" in
    v[0-9]*) ;;
    *) fail "Could not resolve the latest release of ${REPO}. Set MOOKACODE_VERSION=vX.Y.Z explicitly." ;;
  esac
fi

case "$VERSION" in
  v*) TAG="$VERSION" ;;
  *) TAG="v$VERSION" ;;
esac

base_url="https://github.com/${REPO}/releases/download/${TAG}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

say "Downloading MookaCode ${TAG} from ${REPO}..."
fetch_to "${base_url}/mookacode.cjs" "${tmp_dir}/mookacode.cjs" ||
  fail "Could not download ${base_url}/mookacode.cjs"

if fetch_to "${base_url}/SHA256SUMS.txt" "${tmp_dir}/SHA256SUMS.txt" 2>/dev/null; then
  expected="$(awk '$2 == "mookacode.cjs" { print $1 }' "${tmp_dir}/SHA256SUMS.txt" | head -n 1)"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${tmp_dir}/mookacode.cjs" | awk '{ print $1 }')"
    else
      actual="$(shasum -a 256 "${tmp_dir}/mookacode.cjs" | awk '{ print $1 }')"
    fi
    [ "$actual" = "$expected" ] || fail "Checksum mismatch for mookacode.cjs (expected $expected, got $actual)."
    say "Checksum verified."
  fi
else
  say "warning: SHA256SUMS.txt not found in the release, skipping checksum verification."
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR"
install -m 0644 "${tmp_dir}/mookacode.cjs" "${INSTALL_DIR}/mookacode.cjs"
printf '%s\n' "$TAG" > "${INSTALL_DIR}/VERSION"

cat > "${BIN_DIR}/mookacode" <<EOF
#!/usr/bin/env sh
exec node "${INSTALL_DIR}/mookacode.cjs" "\$@"
EOF
chmod 0755 "${BIN_DIR}/mookacode"

say ""
say "MookaCode ${TAG} installed:"
say "  bundle   ${INSTALL_DIR}/mookacode.cjs"
say "  launcher ${BIN_DIR}/mookacode"

case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *)
    say ""
    say "Add ${BIN_DIR} to your PATH, for example:"
    say "  echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ~/.profile"
    ;;
esac

say ""
say "Next:"
say "  mookacode auth set anthropic"
say "  mookacode \"explain this project\""
