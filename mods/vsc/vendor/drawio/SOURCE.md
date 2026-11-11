draw.io viewer, `src/main/webapp/js/viewer-static.min.js` and `LICENSE` from https://github.com/jgraph/drawio at tag v32.6.10
git blob sha1 d62689824fedfe9c6272919f37531972e63cf739 (matches the GitHub API for that tag, checked 2026-11-09)
sha256 of viewer-static.min.js here: 35b8ef54369e938ad2399d3c8ce3945591d4b200a01f6942d0e39743bea1f1a1
Unchanged. It runs only inside the diagram renderer's WebKit view, which blocks every network and file load,
so shapes the viewer would fetch from viewer.diagrams.net (stencil libraries such as cloud icons) stay empty.
