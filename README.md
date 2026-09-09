# DCR converter

Browser tool that turns High Criteria Liberty `.dcr` court recordings into ordinary WAV files. Live at [dcrconverter.com](https://dcrconverter.com). **Nothing is uploaded** — parsing and Speex decode run in your browser.

Each audio channel is saved as its own WAV.

## GitHub Pages

Pages only serves static files. It does not compile C. This repo uses **GitHub Actions** to check out the Speex submodule, build `wasm/speex.wasm`, and publish the site.

In the GitHub repo: **Settings → Pages → Source → GitHub Actions**.

## Local preview

```sh
git submodule update --init
./src/wasm/build.sh
python3 -m http.server 8080
```

Then visit `http://localhost:8080`. You need `clang` with `wasm32` and `lld`. Chrome and Edge can stream a channel straight to a file you pick; other browsers fall back to a same-origin download.

## Speex

The decoder is [Speex 1.2.1](https://github.com/xiph/speex/tree/Speex-1.2.1) (BSD), vendored as `vendor/speex`. Glue and the WASM build live in `src/wasm/`. The compiled binary is a build output, not source.

## What it understands

Liberty containers (`HGCRLCRS`) with Speex ACM audio (`0xA109`). MPEG-4 video chunks (`cadr`) are skipped without loading their bodies, so a 200+ MB dual-camera file can still be converted on a weak machine.

This is not affiliated with High Criteria.
