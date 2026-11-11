@excalidraw/utils 0.1.8, `dist/prod/index.js` (here `excalidraw-utils.js`) from the npm tarball
https://registry.npmjs.org/@excalidraw/utils/-/utils-0.1.8.tgz
sha512-I/Ve4nBTdEPiB8ce/0Rm5eOtIJIF9I8YKQL41Z4FuNBv8YAp/IGKDTl0ryFxlz6Y2AfT+bWbD9cBMiEQOHwUaA== (matches the registry, checked 2026-11-10)
sha256 of the original index.js: d859cee50c6148ba53192da5454d48d8370ced75449a678b6baefc293c29fe6e
sha256 of excalidraw-utils.js here: fbe24318c5e4c7d0f29b5cbca5a0818f183f185b913fcb1fcae71efc8642c3fa
One change, made by scripts/vendor-excalidraw.mjs (run it on the original index.js to get this file): the
embedded Liberation Sans 1.05 font is replaced by a system font reference ("local:", as the library's own
Helvetica entry). That font is GPLv2 with font exceptions, and its source is published only for version 1.07.5,
so it is not redistributed here; its text is drawn with the system's font. The diagram renderer loads it as a module and turns its final `export{...}` into a global at run time
(the file itself is not edited; tests/diagrams.test.mjs checks the hash and that there is one `export{`).
Its fonts are embedded in it, so it fetches none. It runs only inside the renderer's WebKit view, which blocks
every network and file load.

License texts:
- `LICENSE`: Excalidraw, MIT, from https://github.com/excalidraw/excalidraw at commit 701b901a0f1ba3d0b390d9cdf63d112e25abac4b.
- `licenses/OFL-1.1.md`: SIL Open Font License 1.1, from https://github.com/excalidraw/virgil (LICENSE.md, branch main),
  the license of the embedded Virgil, Excalifont, Xiaolai SC, Nunito, Lilita One and Cascadia Code fonts.
- `licenses/ComicShanns.LICENSE`: MIT, the text in the embedded Comic Shanns font's own copyright field.
- `licenses/*.LICENSE` for the libraries the package depends on, each from its npm tarball (registry sha512 matched):
  pako 2.0.3, roughjs 4.6.4, perfect-freehand 1.2.0, png-chunk-text 1.0.0, png-chunks-encode 1.0.0,
  png-chunks-extract 1.0.0, browser-fs-access 0.38.0 (Apache-2.0), @braintree/sanitize-url 6.0.2,
  @excalidraw/laser-pointer 1.3.1; roughjs's own hachure-fill 0.5.2, points-on-path 0.2.1, points-on-curve 0.2.0,
  path-data-parser 0.1.0; and tinycolor2 1.6.0, the dependency of Excalidraw's bundled common package (the
  bundled element package's @excalidraw/fractional-indexing 3.3.0 is CC0-1.0). Dependencies read from
  packages/{utils,common,element,math}/package.json at commit 701b901.
