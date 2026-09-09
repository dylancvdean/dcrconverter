#!/bin/sh
set -eu

WEB="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
if [ -n "${SPEEX_DIR:-}" ]; then
  SPEEX="$SPEEX_DIR"
elif [ -f "$WEB/vendor/speex/libspeex/speex.c" ]; then
  SPEEX="$WEB/vendor/speex"
elif [ -f "$WEB/../third_party/speex-1.2.1/libspeex/speex.c" ]; then
  SPEEX="$WEB/../third_party/speex-1.2.1"
else
  echo "Speex sources not found. Run: git submodule update --init" >&2
  echo "Or set SPEEX_DIR to a Speex 1.2.1 tree." >&2
  exit 1
fi

if [ ! -f "$SPEEX/libspeex/speex.c" ]; then
  echo "Speex sources not found at $SPEEX" >&2
  exit 1
fi

OUT="$WEB/wasm/speex.wasm"
SRC="$SPEEX/libspeex"
INC="$WEB/.build/include"

# speex_types.h includes speex_config_types.h from the same directory.
# Copy public headers and drop in our generated types file so the submodule
# stays unmodified.
mkdir -p "$INC/speex" "$WEB/wasm"
cp "$SPEEX/include/speex/"*.h "$INC/speex/" 2>/dev/null || true
cp "$SPEEX/include/speex/"*.h.in "$INC/speex/" 2>/dev/null || true
cp "$WEB/src/wasm/speex_config_types.h" "$INC/speex/speex_config_types.h"
if [ -f "$SPEEX/COPYING" ]; then
  cp "$SPEEX/COPYING" "$WEB/wasm/COPYING"
fi

# Decoder-only objects; no Vorbis psychoacoustics / FFT.
files="
  cb_search.c
  exc_10_32_table.c
  exc_8_128_table.c
  filters.c
  gain_table.c
  hexc_table.c
  high_lsp_tables.c
  lsp.c
  ltp.c
  speex.c
  stereo.c
  vbr.c
  vq.c
  bits.c
  exc_10_16_table.c
  exc_20_32_table.c
  exc_5_256_table.c
  exc_5_64_table.c
  gain_table_lbr.c
  hexc_10_32_table.c
  lpc.c
  lsp_tables_nb.c
  modes.c
  modes_wb.c
  nb_celp.c
  quant_lsp.c
  sb_celp.c
  speex_callbacks.c
  speex_header.c
  window.c
"

set --
for f in $files; do
  set -- "$@" "$SRC/$f"
done

clang --target=wasm32 -fuse-ld=lld -O2 -nostdlib \
  -ffreestanding -fno-builtin -fno-exceptions \
  -DHAVE_CONFIG_H \
  -I"$WEB/src/wasm" \
  -I"$WEB/src/wasm/include" \
  -I"$INC" \
  -Wl,--no-entry \
  -Wl,--export-memory \
  -Wl,--allow-undefined \
  -o "$OUT" \
  "$WEB/src/wasm/libc.c" \
  "$WEB/src/wasm/glue.c" \
  "$@"

ls -l "$OUT"
echo "wrote $OUT"
