#!/usr/bin/env bash
# Removes the MookaCode launcher and bundle installed by install.sh or
# scripts/install-cli.sh. Configuration and sessions in ~/.mookacode are kept.

set -euo pipefail

install_dir="${MOOKACODE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mookacode}"
bin_dir="${MOOKACODE_BIN_DIR:-$HOME/.local/bin}"

rm -f "$bin_dir/mookacode"
rm -rf "$install_dir"

echo "Removed $bin_dir/mookacode and $install_dir"
echo 'Configuration and sessions in ~/.mookacode were left untouched.'
