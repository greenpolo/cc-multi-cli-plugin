# Repository banner

`banner.svg` is the README image. It uses SVG shapes and text, with no scripts,
remote fonts, embedded raster images or external asset requests.

To add a provider:

1. Edit `providers` at the top of [`scripts/banner.mjs`](../../scripts/banner.mjs).
2. Choose an `icon` from the inline SVG marks, or add a vector mark to `icons`.
   Only include implemented integrations in the banner.
3. Run `npm run banner:generate` and review `docs/assets/banner.svg` in a browser.

The design follows the original README banner: monospace title, solid black
background, a central pixel mascot and provider icons connected by spokes. The
providers ring the mascot at equal angles, so the arrangement stays symmetric about
it whatever the count, and the canvas height follows automatically. Palette, wording
and layout live in the same script. Keep changes there; direct SVG edits are
overwritten.
`npm run banner:check` (also part of CI's `npm run check`) verifies exact output.
The README supplies alt text; the SVG also contains a title and description.

The OpenAI mark comes from [Simple Icons 11.0.0](https://github.com/simple-icons/simple-icons/blob/11.0.0/icons/openai.svg),
under [CC0](https://github.com/simple-icons/simple-icons/blob/11.0.0/LICENSE.md).
The Grok mark is the official icon served at <https://grok.com/images/favicon.svg>,
retrieved on September 21, 2026: the two glyph paths only, scaled into the icon box
and recolored with `currentColor`. It is a trademark of xAI, reproduced to identify
the provider; xAI publishes no open license for it and this is not a claim of
affiliation or endorsement. Remove it on request from the owner.
Other marks are editable vector interpretations for this banner, not official brand assets.

The accent is Anthropic orange `#d97757`, with `#faf9f5` light text from [Anthropic’s brand guidelines](https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md).
The background is pure black (`#000000`), with no gradient or texture.

## Luna worker showcase

`luna-workers.png` is a rendered capture of a real Claude Code 2.1.273 terminal
session on September 16, 2026, using this repository's launcher, native Claude
Fable 5.1, and `openai-luna` workers backed by GPT-5.6 Luna.

The frame shows the first two workers starting during a four-worker read-only
request. The demo was stopped after capture to limit usage; the image does not
claim completed reviews. Terminal text and counters are unchanged. The captured
session used monochrome output; the PNG uses Source Code Pro on a dark background
with unused terminal rows trimmed. No model-generated UI or invented results.

`luna-workers.txt` preserves the visible terminal text used for the image.

## Multi-provider worker showcase

`multi-provider-workers.svg` is the README's editable illustration, based on the
real Luna capture above. It adds Grok 4.6 through Cursor and Gemini 3.8 Flash
through Antigravity alongside two GPT-5.6 Luna workers. The prompt, launch list,
worker rows, and additional elapsed times are edited to illustrate the combined
workflow; they are not evidence of a live mixed-provider run. No extra inference
was used to create this version. The README caption labels it as an illustration
and links here for provenance.

Edit the SVG text elements directly. The asset is self-contained, with accessible
title and description, no scripts, and no external fonts or image requests.
