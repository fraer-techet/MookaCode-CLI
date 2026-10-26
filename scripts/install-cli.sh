#!/usr/bin/env bash
# Builds MookaCode from source and installs a `mookacode` launcher (Linux/macOS).
#
#   pnpm install && pnpm build && ./scripts/install-cli.sh
#
# Environment:
#   MOOKACODE_INSTALL_DIR  where the bundle lives (default: ~/.local/share/mookacode)
#   MOOKACODE_BIN_DIR      where the launcher goes (default: ~/.local/bin)

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$root/packages/cli/dist/mookacode.cjs"
install_dir="${MOOKACODE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mookacode}"
bin_dir="${MOOKACODE_BIN_DIR:-$HOME/.local/bin}"

if [ ! -f "$dist" ]; then
  echo 'Building MookaCode CLI...'
  node "$root/scripts/build-cli.mjs"
fi

mkdir -p "$install_dir" "$bin_dir"
cp "$dist" "$install_dir/mookacode.cjs"
chmod 0644 "$install_dir/mookacode.cjs"

cat > "$bin_dir/mookacode" <<EOF
#!/usr/bin/env sh
exec node "$install_dir/mookacode.cjs" "\$@"
EOF
chmod 0755 "$bin_dir/mookacode"

echo "Installed MookaCode CLI:"
echo "  bundle   $install_dir/mookacode.cjs"
echo "  launcher $bin_dir/mookacode"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    echo
    echo "Add $bin_dir to your PATH, for example:"
    echo "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.profile"
    ;;
esac

"$bin_dir/mookacode" --version
echo "Try: mookacode auth set anthropic"
