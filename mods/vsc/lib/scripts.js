// The shell scripts behind Search and Quick Open. Pure strings, so tests run them with the system's
// sh. Every folder, path and search text is a positional argument, never part of the script.

// Every script starts here: PATH keeps only absolute folders, so a program planted in the folder a
// script works in is never run in place of the real one (when "." or "" is on the user's PATH).
// Pure sh, so no program is looked up before PATH is clean; with nothing absolute left, the
// system folders (an empty PATH would mean the current folder to some shells).
export const SAFE_PATH = 'set -f; p=; o=$IFS; IFS=:; for x in $PATH; do case $x in /*) p=${p:+$p:}$x;; esac; done; IFS=$o; set +f; PATH=${p:-/usr/bin:/bin}; export PATH';

// Files under the folder ($1), .git skipped, symlinks not followed. The output stops at 3 MB (well
// over 10,000 names), which also stops find in a huge folder such as home.
export const FIND = `${SAFE_PATH}; cd "$1" || exit 2; find . -name .git -prune -o -type f -print0 | head -c 3000000`;

// Of the paths after $3, those containing the text $3 (fixed string; $2 is -s or -is).
export const GREP = `${SAFE_PATH}; cd "$1" && flags=$2 && pattern=$3 && shift 3 && exec grep -lIF $flags --null -e "$pattern" -- "$@"`;

// Of the "./"-prefixed paths after $1: regular files up to 1 MiB, a "--" entry, then those over it.
// A symlink as the last part is in neither. Every path starts with "./", so "--" cannot be one.
export const SIZES = `${SAFE_PATH}; cd "$1" || exit 2; shift; find "$@" -prune -type f -size -1048577c -print0; printf "%s\\0" --; find "$@" -prune -type f -size +1048576c -print0`;

// The real path of the folder $1, then of each "./"-prefixed folder after it (empty when it cannot
// be entered), following symlinks. One shell for all folders: after `cd -P`, $PWD is the real path
// (no subshell per folder, and no command substitution to drop a trailing newline from a name).
export const REAL_FOLDERS = `${SAFE_PATH}; cd -P -- "$1" || exit 2; root=$PWD; printf "%s\\0" "$root"; shift; for d in "$@"; do if cd -P -- "$root/$d" 2>/dev/null; then printf "%s\\0" "$PWD"; else printf "\\0"; fi; done`;

// Problems: which of the paths after $1 exist in the folder $1, then "@ruff=" with ruff's path on
// PATH, "@pyproject-ruff" when pyproject.toml has a [tool.ruff] table, "@id=" with the folder's
// device:inode (GNU stat first: BSD stat -c fails cleanly, GNU stat -f would print) and "@real="
// with its real path.
export const DETECT = `${SAFE_PATH}; cd -P -- "$1" || exit 2; shift; for f in "$@"; do if [ -e "$f" ]; then printf "%s\\0" "$f"; fi; done; if r=$(command -v ruff 2>/dev/null); then printf "@ruff=%s\\0" "$r"; fi; if [ -f pyproject.toml ] && grep -q "^\\[tool\\.ruff" pyproject.toml; then printf "%s\\0" @pyproject-ruff; fi; if id=$(stat -c %d:%i . 2>/dev/null || stat -f %d:%i . 2>/dev/null); then printf "@id=%s\\0" "$id"; fi; printf "@real=%s\\0" "$PWD"`;

// Runs the program and arguments after $3 in the real folder $1 (refused when $1 is not its own
// real path, e.g. a symlink retargeted since it was trusted) in the background: output to $2.out
// and $2.err and, when it ends, its exit code to $2.code, or "timeout" after $3 seconds, enforced
// here so it holds even when nobody waits. Prints the background shell's pid and returns at once:
// exec stops a program after 30 s, and a type check can take longer.
export const RUN_BACKGROUND = `${SAFE_PATH}; cd -P -- "$1" || exit 2; [ "$PWD" = "$1" ] || exit 3; out=$2; limit=$3; shift 3; ( "$@" > "$out.out" 2> "$out.err" < /dev/null & pid=$!; ( sleep "$limit" && : > "$out.timeout" && kill "$pid" ) > /dev/null 2>&1 & dog=$!; wait "$pid"; code=$?; pkill -P "$dog" 2>/dev/null; kill "$dog" 2>/dev/null; if [ -e "$out.timeout" ]; then code=timeout; fi; echo "$code" > "$out.code" ) > /dev/null 2>&1 < /dev/null & echo $!`;

// chmod arguments that make a folder private to its owner. BSD chmod (macOS) takes "--" only
// before the mode; after it, "--" would be read as a file name.
export const privateFolderArgs = (path) => ["--", "700", path];

// Saving on another machine (writeTextFile works only on this computer), in three steps.
// Prepare: for the path $1 (through a symlink, the file it points to; it must be a regular file
// or not exist), a new temporary file beside it, mode 600 while it fills. Temporary files of
// saves that never finished (over an hour old) are removed there first: they can hold part of a
// file. Prints "tmp\0real"; exit 9 when this system cannot resolve a symlink.
export const SAVE_PREPARE = `${SAFE_PATH}; if [ -L "$1" ]; then r=$(readlink -f -- "$1" 2>/dev/null || realpath -- "$1" 2>/dev/null) || exit 9; else r=$1; fi; if [ -e "$r" ] && [ ! -f "$r" ]; then exit 3; fi; d=$(dirname -- "$r"); find "$d" -maxdepth 1 -type f -name ".vsc-save.??????" -mmin +60 -exec rm -f -- {} + 2>/dev/null; t=$(mktemp "$d/.vsc-save.XXXXXX") || exit 4; printf "%s\\0%s" "$t" "$r"`;

// Only a save's own temporary file (named by mktemp above) may be appended to or removed.
const OWN_TMP = 'case "${1##*/}" in .vsc-save.??????) ;; *) exit 2;; esac; [ -f "$1" ] && [ ! -L "$1" ] || exit 2';

// Append: the text $2 to the temporary file $1, byte for byte.
export const SAVE_APPEND = `${SAFE_PATH}; ${OWN_TMP}; printf "%s" "$2" >> "$1"`;

// Commit: moves the temporary file $1 over $2 only if $1 holds exactly what was sent (cksum $4;
// exit 7 otherwise) and $2 still has the cksum $3, or does not exist when $3 is empty (exit 5
// otherwise). An existing file must belong to this user (exit 8: replacing it would change its
// owner) and keeps its mode and group; a new one gets the umask's mode. mv in one folder replaces
// it in one step (a new inode: hard links and ACLs are not carried over).
export const SAVE_COMMIT = `${SAFE_PATH}; ${OWN_TMP}; want=$4; got=$(cksum < "$1") || exit 7; set -- "$1" "$2" "$3" $got; [ "$4 $5" = "$want" ] || exit 7; if [ -z "$3" ]; then if [ -e "$2" ] || [ -L "$2" ]; then exit 5; fi; m=$(printf %o $(( 0666 & ~$(umask) ))); else [ -f "$2" ] || exit 5; now=$(cksum < "$2") || exit 5; set -- "$1" "$2" "$3" $now; [ "$4 $5" = "$3" ] || exit 5; u=$(stat -c %u -- "$2" 2>/dev/null || stat -f %u -- "$2") || exit 6; [ "$u" = "$(id -u)" ] || exit 8; g=$(stat -c %g -- "$2" 2>/dev/null || stat -f %g -- "$2") || exit 6; chgrp "$g" "$1" || exit 6; m=$(stat -c %a -- "$2" 2>/dev/null || stat -f %Lp -- "$2") || exit 6; fi; chmod "$m" "$1" || exit 6; mv -f -- "$1" "$2"`;

// Abort: removes the temporary file $1 after a failed save.
export const SAVE_ABORT = `${SAFE_PATH}; ${OWN_TMP}; rm -f -- "$1"`;

// Explorer's file actions. Each takes the Explorer's folder $1 and paths relative to it ("" is the
// folder itself). Every folder involved is resolved to its real path and must be the folder or
// below it (exit 10): a symlink to somewhere else is never written through. An entry itself is not
// resolved, so a link is renamed, copied or deleted as a link. Exit 5: the name is taken.
const FOLDER_ROOT = 'cd -P -- "$1" || exit 2; root=$PWD; real() { d=$(cd -P -- "$root/$1" 2>/dev/null && printf "%sX" "$PWD") || return 1; d=${d%X}; case "$d" in "$root"|"$root"/*) return 0;; *) return 1;; esac; }; named() { case "$1" in ""|.|..|*/*) return 1;; esac; }';
// An entry $1 (relative): sets e to its path in its real parent folder, n to its name.
const ENTRY = 'entry() { case "$1" in */*) p=${1%/*};; *) p="";; esac; n=${1##*/}; named "$n" || return 1; real "$p" || return 1; e="$d/$n"; [ -e "$e" ] || [ -L "$e" ]; }';

// New empty file $3 in the folder $2; never over an existing name (noclobber).
export const FILE_NEW = `${SAFE_PATH}; ${FOLDER_ROOT}; named "$3" || exit 10; real "$2" || exit 10; ( set -C; : > "$d/$3" ) 2>/dev/null || exit 5`;

// New folder $3 in the folder $2.
export const FOLDER_NEW = `${SAFE_PATH}; ${FOLDER_ROOT}; named "$3" || exit 10; real "$2" || exit 10; if [ -e "$d/$3" ] || [ -L "$d/$3" ]; then exit 5; fi; mkdir -- "$d/$3" || exit 6`;

// Moves the entry $2 into the folder $3 under the name $4 (rename, cut and paste); mv -n never
// replaces, and an entry still in place afterwards means the name was taken meanwhile. A rename
// that changes only letter case (a.txt to A.txt, the same file where case is ignored) goes
// through a new private folder from mktemp -d, so no name planted beforehand can redirect it.
// If it can neither finish nor go back (both names taken meanwhile), it prints where the entry
// was left and exits 12.
export const ENTRY_MOVE = `${SAFE_PATH}; ${FOLDER_ROOT}; ${ENTRY}; entry "$2" || exit 10; s=$e; sd=$d; named "$4" || exit 10; real "$3" || exit 10; t="$d/$4"; if [ -e "$t" ] || [ -L "$t" ]; then lower() { printf %s "$1" | tr A-Z a-z; }; if [ "$sd" = "$d" ] && [ "$n" != "$4" ] && [ "$(lower "$n")" = "$(lower "$4")" ] && [ "$s" -ef "$t" ]; then m=$(mktemp -d "$d/.vsc-rename.XXXXXX") || exit 6; mv -n -- "$s" "$m/x" || { rmdir -- "$m"; exit 6; }; mv -n -- "$m/x" "$t"; if [ -e "$m/x" ] || [ -L "$m/x" ]; then mv -n -- "$m/x" "$s"; if [ -e "$m/x" ] || [ -L "$m/x" ]; then printf %s "$m/x"; exit 12; fi; rmdir -- "$m"; exit 6; fi; rmdir -- "$m"; exit 0; fi; exit 5; fi; mv -n -- "$s" "$t" || exit 6; if [ -e "$s" ] || [ -L "$s" ]; then exit 5; fi`;

// Copies the entry $2 (folders with their contents, links as links) into the folder $3 as $4.
export const ENTRY_COPY = `${SAFE_PATH}; ${FOLDER_ROOT}; ${ENTRY}; entry "$2" || exit 10; s=$e; named "$4" || exit 10; real "$3" || exit 10; t="$d/$4"; if [ -e "$t" ] || [ -L "$t" ]; then exit 5; fi; cp -RP -- "$s" "$t" || exit 6`;

// Moves the entry $2 to the user's trash; exit 11 when there is none. macOS: Apple's /usr/bin/trash
// by its full path (Homebrew's trash, often first on PATH, reads -s as "empty the Trash"), or
// Finder before macOS 15 (not for a symlink, which Finder might resolve). Elsewhere: gio trash.
export const ENTRY_TRASH = `${SAFE_PATH}; ${FOLDER_ROOT}; ${ENTRY}; entry "$2" || exit 10; if [ "$(uname -s 2>/dev/null)" = Darwin ]; then if [ -x /usr/bin/trash ]; then /usr/bin/trash -s "$e" || exit 6; elif [ -L "$e" ]; then exit 11; else /usr/bin/osascript -e "on run argv" -e "tell application \\"Finder\\" to delete (POSIX file (item 1 of argv) as alias)" -e "end run" "$e" > /dev/null || exit 6; fi; elif command -v gio > /dev/null 2>&1; then gio trash -- "$e" || exit 6; else exit 11; fi`;

// Deletes the entry $2 for good (only after the user confirmed it twice; a folder with its contents).
export const ENTRY_DELETE = `${SAFE_PATH}; ${FOLDER_ROOT}; ${ENTRY}; entry "$2" || exit 10; rm -rf -- "$e" || exit 6`;

// PDF pages as pictures, drawn by macOS PDFKit. Compiled once with swiftc (lib/viewers.js keeps
// the binary under a name that follows this source and the compiler flags). Arguments: the PDF,
// the output prefix, the first page (from 1), how many pages, the width in pixels. Prints the page
// count; writes "<prefix><page>.png". Pages are drawn as viewers show them: the crop box, turned by
// the page's rotation, and never taller than MAX_HEIGHT (a 1 x 14400 pt strip would otherwise ask
// for millions of pixels). Exit 2: not a PDF; 4: locked with a password; 3: a page could not be drawn.
// With "--text" first (then the PDF, the first page, how many), it prints the page count, then per
// page "t" (its own text) or "o" (recognized), a tab, and the text ended by a NUL (a NUL in the
// text itself is dropped). A page with under 20 characters of its own text (a scan, maybe with a
// stamped page number) is drawn and read with macOS Vision; it keeps its own text when that is longer.
export const PDF_RENDERER = `import AppKit
import PDFKit
import Vision

// A page's text read from its picture, lines in reading order; "" when nothing is found.
func recognize(_ page: PDFPage) -> String {
  let box = page.bounds(for: .cropBox)
  let turned = page.rotation % 180 != 0
  let w = max(Double(turned ? box.height : box.width), 1), h = max(Double(turned ? box.width : box.height), 1)
  let scale = min(2000.0 / w, maxHeight / h)
  let picture = page.thumbnail(of: NSSize(width: w * scale, height: h * scale), for: .cropBox)
  guard let image = picture.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return "" }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.automaticallyDetectsLanguage = true
  do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { return "" }
  return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\\n")
}

let maxHeight = 6000.0
let a = CommandLine.arguments
if a.count == 5 && a[1] == "--text" {
  guard let first = Int(a[3]), let count = Int(a[4]), first >= 1, count >= 0 else { exit(1) }
  guard let doc = PDFDocument(url: URL(fileURLWithPath: a[2])) else { exit(2) }
  if doc.isLocked { exit(4) }
  var out = "\\(doc.pageCount)\\n"
  var p = first - 1
  while p < min(doc.pageCount, first - 1 + count) {
    guard let page = doc.page(at: p) else { exit(3) }
    let own = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let read = own.filter { !$0.isWhitespace }.count < 20 ? recognize(page).trimmingCharacters(in: .whitespacesAndNewlines) : ""
    let recognized = read.count > own.count
    out += (recognized ? "o\\t" : "t\\t") + (recognized ? read : own).replacingOccurrences(of: "\\0", with: "") + "\\0"
    p += 1
  }
  FileHandle.standardOutput.write(out.data(using: .utf8)!)
  exit(0)
}
guard a.count == 6, let first = Int(a[3]), let count = Int(a[4]), let width = Double(a[5]), first >= 1, count >= 0, width > 0 else { exit(1) }
guard let doc = PDFDocument(url: URL(fileURLWithPath: a[1])) else { exit(2) }
if doc.isLocked { exit(4) }
print(doc.pageCount)
var i = first - 1
while i < min(doc.pageCount, first - 1 + count) {
  guard let page = doc.page(at: i) else { exit(3) }
  let box = page.bounds(for: .cropBox)
  let turned = page.rotation % 180 != 0
  let w = max(Double(turned ? box.height : box.width), 1), h = max(Double(turned ? box.width : box.height), 1)
  let scale = min(width / w, maxHeight / h)
  let picture = page.thumbnail(of: NSSize(width: w * scale, height: h * scale), for: .cropBox)
  guard let tiff = picture.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:]) else { exit(3) }
  do { try png.write(to: URL(fileURLWithPath: "\\(a[2])\\(i + 1).png")) } catch { exit(3) }
  i += 1
}
`;

const absolute = (path) => {
  if (!String(path).startsWith("/")) throw new Error(`Not an absolute path: ${path}`);
  return path;
};

export const COMPILE_FLAGS = ["-O"];

// xcode-select -p fails quietly without the command line tools; /usr/bin/swiftc would instead
// ask the person to install them.
export const swiftCheckArgs = () => ["/usr/bin/xcode-select", ["-p"]];
// A first compile with an empty module cache takes up to ~30 s: viewers.js gives it its own timeout.
export const compileArgs = (source, out) => ["/usr/bin/swiftc", [...COMPILE_FLAGS, absolute(source), "-o", absolute(out)]];
// Herdr's fs has no rename: mv puts the finished binary in place in one step (same folder).
export const installArgs = (partial, bin) => ["/bin/mv", ["-f", absolute(partial), absolute(bin)]];
export const textArgs = (renderer, pdf, first, count) =>
  [absolute(renderer), ["--text", absolute(pdf), String(first), String(count)]];
export const renderArgs = (renderer, pdf, prefix, first, count, width) =>
  [absolute(renderer), [absolute(pdf), absolute(prefix), String(first), String(count), String(width)]];

// Word, RTF and OpenDocument text as HTML on stdout (macOS textutil). The format is named, so a
// file that is really HTML is refused instead of converted (converting HTML fetches its remote
// images and stylesheets). textutil exits 0 even then: it reports "Error reading" on stderr.
const DOCUMENT_FORMATS = new Set(["docx", "doc", "rtf", "odt"]);
// `format` overrides the extension: Word often saves RTF under .doc.
export function documentArgs(path, format = String(path).split(".").pop().toLowerCase()) {
  if (!DOCUMENT_FORMATS.has(format)) throw new Error(`Not a document format: ${format}`);
  return ["/usr/bin/textutil", ["-format", format, "-convert", "html", "-stdout", absolute(path)]];
}

export const osNameArgs = () => ["uname", ["-s"]];

// The file in the app the system opens it with. On Linux `open` is often openvt, and xdg-open's
// folder differs between systems, so only macOS's has a fixed path.
export const defaultAppArgs = (mac, path) => [mac ? "/usr/bin/open" : "xdg-open", [absolute(path)]];

// FNV-1a of a tool's source and flags, as in files.js's draft names; `prefix` keeps tools apart.
export function rendererName(source, flags = COMPILE_FLAGS, prefix = "render") {
  const text = `${source}\n${flags.join(" ")}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${prefix}-${h.toString(36)}`;
}

// Diagrams as pictures, drawn by a JS library in a windowless WebKit view (macOS), compiled once
// like the PDF renderer. The view blocks every load (network and files), so a diagram can never
// fetch anything; its source goes in as a JSON string, never as markup.
export const DIAGRAM_RENDERER = String.raw`import AppKit
import WebKit

// Arguments: the kind ("mermaid", "drawio" or "excalidraw"), the library .js, the diagram source file, the output
// .png, the theme ("light" or "dark"), the page (from 0; draw.io files can have several). Exit 2:
// the diagram has an error (message on stderr); 3: no picture could be made; 4: it took too long;
// 1: wrong arguments.
let a = CommandLine.arguments
guard a.count == 7, ["mermaid", "drawio", "excalidraw"].contains(a[1]), ["light", "dark"].contains(a[5]),
      let pageIndex = Int(a[6]), pageIndex >= 0,
      let library = try? String(contentsOfFile: a[2], encoding: .utf8),
      let source = try? String(contentsOfFile: a[3], encoding: .utf8) else { exit(1) }
let output = a[4], dark = a[5] == "dark", kind = a[1]

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

// Excalidraw's library is an ES module: it runs as a module script, its final export{...} turned
// into a global (only here, the file is not edited). Its fonts are inside it, so it never fetches
// one. Other libraries are classic scripts.
var script = library, module = ""
if kind == "excalidraw" {
  guard let start = library.range(of: "export{", options: .backwards),
        let end = library.range(of: "}", range: start.upperBound..<library.endIndex) else { fail(3, "The Excalidraw library is not in the expected form.") }
  let names = library[start.upperBound..<end.lowerBound].split(separator: ",").map { name -> String in
    let parts = name.components(separatedBy: " as ")
    return parts.count == 2 ? "\(parts[1]):\(parts[0])" : "\(name):\(name)"
  }
  script = library.replacingCharacters(in: start.lowerBound..<end.upperBound, with: "window.ExcalidrawUtils={\(names.joined(separator: ","))};")
  module = " type=\"module\""
}

// The source goes in as a JSON string, never as markup or code. "<" is escaped too: JSON leaves it,
// and "<!--" then "<script" in a diagram's text would make HTML read past the script's end.
guard let json = try? JSONSerialization.data(withJSONObject: [source]),
      let quoted = String(data: json, encoding: .utf8)?.replacingOccurrences(of: "<", with: "\\u003c") else { exit(1) }
let page = """
<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:\(dark ? "#1e1e1e" : "#ffffff")} #d{display:inline-block;padding:16px}</style>
</head><body><div id="d"></div><script\(module)>\(script)</script><script\(module)>
(async () => {
  // The page refuses to draw if WebRTC is there after all (see peerConnectionEnabled below).
  if (typeof RTCPeerConnection !== "undefined") { webkit.messageHandlers.done.postMessage({ blocked: "WebRTC could not be switched off." }); return; }
  try {
    const box = document.getElementById("d"), text = \(quoted)[0];
    if ("\(kind)" === "excalidraw") {
      let scene;
      try { scene = JSON.parse(text); } catch (e) { throw new Error("This is not a valid Excalidraw file (its JSON cannot be read)."); }
      if (!scene || !Array.isArray(scene.elements)) throw new Error("This is not an Excalidraw file (it has no elements).");
      const elements = scene.elements.filter(e => e && typeof e === "object" && !e.isDeleted);
      if (!elements.length) throw new Error("This drawing has nothing to draw.");
      // A canvas, not a PNG blob: WebKit cannot read a blob back in this view (FileReader fails).
      const canvas = await ExcalidrawUtils.exportScene({ type: "canvas",
        data: { elements, appState: scene.appState || {}, files: scene.files || null },
        // Sharp on Retina, but never over 8000 px on either side.
        config: { theme: "\(dark ? "dark" : "light")", scale: (w, h) => Math.min(2, 8000 / Math.max(w, h, 1)) } });
      if (!canvas.width || !canvas.height) throw new Error("This drawing has nothing to draw.");
      const png = canvas.toDataURL("image/png").split(",")[1];
      webkit.messageHandlers.done.postMessage({ png });
      return;
    }
    if ("\(kind)" === "mermaid") {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "\(dark ? "dark" : "default")" });
      box.innerHTML = (await mermaid.render("vsc", text)).svg;
    } else {
      const xml = mxUtils.parseXml(text);
      if (!xml.documentElement || xml.getElementsByTagName("parsererror").length) throw new Error("This is not a valid draw.io file (its XML cannot be read).");
      new GraphViewer(box, xml.documentElement, { highlight: "none", nav: false, lightbox: false, toolbar: null,
        resize: true, page: \(pageIndex), "dark-mode": \(dark ? "true" : "false") });
      if (!box.querySelector("svg")) throw new Error("This draw.io page has nothing to draw.");
    }
    await document.fonts.ready;
    const r = box.getBoundingClientRect();
    webkit.messageHandlers.done.postMessage({ w: Math.ceil(r.width), h: Math.ceil(r.height) });
  } catch (e) {
    webkit.messageHandlers.done.postMessage({ error: String(e && e.message || e) });
  }
})();
</script></body></html>
"""

final class Drawer: NSObject, WKScriptMessageHandler {
  var web: WKWebView!
  func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
    guard let body = m.body as? [String: Any] else { fail(3, "No answer from the diagram.") }
    if let blocked = body["blocked"] as? String { fail(3, blocked) }
    if let error = body["error"] as? String { fail(2, error) }
    // A library that draws its own picture (Excalidraw) hands it over as base64.
    if let png = body["png"] as? String {
      guard let data = Data(base64Encoded: png), data.count > 0 else { fail(3, "The picture could not be made.") }
      do { try data.write(to: URL(fileURLWithPath: output)) } catch { fail(3, "The picture could not be saved.") }
      exit(0)
    }
    let w = min(max((body["w"] as? Double) ?? 0, 1), 8000), h = min(max((body["h"] as? Double) ?? 0, 1), 8000)
    web.frame = NSRect(x: 0, y: 0, width: w, height: h)
    let config = WKSnapshotConfiguration()
    config.rect = NSRect(x: 0, y: 0, width: w, height: h)
    // Sharp on Retina, but never over 8000 px on either side (a huge diagram is drawn smaller).
    config.snapshotWidth = NSNumber(value: w * min(2, 8000 / max(w, h)))
    web.takeSnapshot(with: config) { image, _ in
      guard let image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
            let png = bitmap.representation(using: .png, properties: [:]) else { fail(3, "The picture could not be made.") }
      do { try png.write(to: URL(fileURLWithPath: output)) } catch { fail(3, "The picture could not be saved.") }
      exit(0)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let drawer = Drawer()
// Nothing may load from anywhere: a diagram must not reach the network or local files. The
// compiled rule is kept next to this program (default() would keep it in ~/Library/WebKit).
let rulesFolder = URL(fileURLWithPath: a[0]).deletingLastPathComponent().appendingPathComponent("webkit-rules")
guard let store = WKContentRuleListStore(url: rulesFolder) else { fail(3, "Network blocking could not be set up.") }
store.compileContentRuleList(forIdentifier: "vsc-block-all",
    encodedContentRuleList: #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]"#) { rules, error in
  guard let rules else { fail(3, "Network blocking could not be set up: \(error?.localizedDescription ?? "")") }
  let config = WKWebViewConfiguration()
  config.userContentController.add(drawer, name: "done")
  config.userContentController.add(rules)
  config.websiteDataStore = .nonPersistent()
  // WebRTC (STUN, TURN) is outside content rules: it is switched off. A private setting; if a macOS
  // drops the key, setValue throws and the renderer stops, so it never runs with WebRTC on.
  config.preferences.setValue(false, forKey: "peerConnectionEnabled")
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1600, height: 1200), configuration: config)
  drawer.web = web
  web.loadHTMLString(page, baseURL: nil)
}
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fail(4, "Drawing the diagram took too long.") }
app.run()
`;

const DIAGRAM_KINDS = new Set(["mermaid", "drawio", "excalidraw"]), THEMES = new Set(["light", "dark"]);
export function diagramArgs(renderer, kind, library, source, out, theme, page = 0) {
  if (!DIAGRAM_KINDS.has(kind)) throw new Error(`Not a diagram kind: ${kind}`);
  if (!THEMES.has(theme)) throw new Error(`Not a theme: ${theme}`);
  if (!Number.isInteger(page) || page < 0) throw new Error(`Not a page: ${page}`);
  return [absolute(renderer), [kind, absolute(library), absolute(source), absolute(out), theme, String(page)]];
}

// Pictures inside Word / OpenDocument files (zip archives). The listing is only a first filter: an
// archive's sizes can lie. Entry names are checked plain names (documents.js pictureEntries), so
// none reads as an option or a pattern.
export const zipListArgs = (archive) => ["/usr/bin/unzip", ["-l", absolute(archive)]];

// Copies one entry: $1 archive, $2 entry, $3 byte cap, $4 output; prints the bytes written. unzip -p
// writes the entry's stored bytes to the pipe (a symlink entry gives its link text, never what it
// points at), and head stops at the cap whatever the archive claims.
export const PICTURE_COPY = `${SAFE_PATH}; /usr/bin/unzip -p -- "$1" "$2" | head -c "$3" > "$4" || exit 2; wc -c < "$4"`;

// PlantUML diagrams, drawn by a plantuml installed on this machine (never a PlantUML server, which
// would publish the diagram's text). Homebrew's folders are added after the user's PATH: an app
// started from the Dock often lacks them. SANDBOX stops !include of local files and URLs and
// remote themes; it is set for PlantUML and, for a wrapper that drops it, through Java's options.
// PlantUML runs in a new empty folder next to the output, removed after, because some pragmas
// (svek_trace) write files into the current folder. A watchdog stops it after $3 seconds, so a
// timeout never leaves a JVM running (exec's own timeout stops only this shell).
// $1 the diagram source, $2 the output .png, $3 the limit in seconds. Exit 2: an error in the
// diagram (PlantUML's 200; its error picture is not kept); 3: plantuml failed; 4: it took too long;
// 5: plantuml is not installed.
export const PLANTUML_FOLDERS = "/opt/homebrew/bin:/usr/local/bin";
export const PLANTUML = `${SAFE_PATH}; PATH=$PATH:${PLANTUML_FOLDERS}; p=$(command -v plantuml) || exit 5; w=$(mktemp -d "\${2%/*}/puml.XXXXXX") || exit 3; cd -P -- "$w" || exit 3; PLANTUML_SECURITY_PROFILE=SANDBOX JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -DPLANTUML_SECURITY_PROFILE=SANDBOX" "$p" -tpng -charset UTF-8 -pipe < "$1" > "$2" & pid=$!; ( sleep "$3" && : > "$w/.timeout" && kill "$pid" ) > /dev/null 2>&1 & dog=$!; wait "$pid"; c=$?; pkill -P "$dog" 2>/dev/null; kill "$dog" 2>/dev/null; [ -e "$w/.timeout" ] && c=timeout; cd / && rm -rf -- "$w"; if [ "$c" = 0 ] && [ -s "$2" ]; then exit 0; fi; rm -f -- "$2"; case $c in 200) exit 2;; timeout) exit 4;; *) exit 3;; esac`;
export function plantumlArgs(source, out, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`Not a time limit: ${limit}`);
  return ["/bin/sh", ["-c", PLANTUML, "vsc", absolute(source), absolute(out), String(limit)]];
}

// A program run inside a folder that may not be trusted (a repository): the shell cleans PATH first and
// only then enters the folder, so a program planted there (with "." on the user's PATH) never runs in
// place of git. A folder that cannot be entered gives 128, git's own "not a repository" code.
export const IN_FOLDER = `${SAFE_PATH}; cd -- "$1" || exit 128; shift; exec "$@"`;
export const inFolderArgs = (folder, argv) => ["/bin/sh", ["-c", IN_FOLDER, "vsc", folder, ...argv]];
