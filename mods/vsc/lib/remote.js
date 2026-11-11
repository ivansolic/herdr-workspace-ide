// Writing a file here or on another machine. Herdr's writeTextFile works only on this computer;
// on another machine the text goes over exec into a temporary file beside the target, which
// replaces it only if the target still holds the text the edit was based on (as writeTextFile).
import { exec, writeTextFile } from "herdr";
import { failure } from "./git.js";
import { SAVE_PREPARE, SAVE_APPEND, SAVE_COMMIT, SAVE_ABORT } from "./scripts.js";
import { posixCksum, textChunks } from "./remote-text.js";

const CHUNK = 32000; // UTF-16 units per argument: under Linux's 128 KiB at 3 bytes each

export class StaleFile extends Error {}

async function remoteWrite(path, text, expected, on) {
  // A program argument cannot carry a NUL byte: the text would arrive cut short.
  if (text.includes("\0")) throw new Error("This text contains a NUL character and cannot be saved on another machine.");
  const run = (script, ...args) => exec("sh", ["-c", script, "vsc", ...args], { on });
  const prep = await run(SAVE_PREPARE, path);
  if (prep.code === 3) throw new Error("This is not a regular file, so it is not saved.");
  if (prep.code === 9) throw new Error("This file is a symlink, and that machine has neither readlink -f nor realpath to find where it points.");
  if (prep.code !== 0) throw new Error(failure(prep));
  const [tmp, real] = prep.stdout.split("\0");
  try {
    for (const chunk of textChunks(text, CHUNK)) {
      const r = await run(SAVE_APPEND, tmp, chunk);
      if (r.code !== 0) throw new Error(failure(r));
    }
    const done = await run(SAVE_COMMIT, tmp, real, expected === null ? "" : posixCksum(expected), posixCksum(text));
    if (done.code === 5) throw new StaleFile("The file changed since it was read.");
    if (done.code === 7) throw new Error("The text did not arrive whole on the other machine; the file was not changed.");
    if (done.code === 6) throw new Error("The file's group or mode could not be kept (are you in its group?), so it was not saved.");
    if (done.code === 8) throw new Error("This file belongs to another user; saving would make it yours, so it was not saved.");
    if (done.code !== 0) throw new Error(failure(done));
  } catch (e) {
    await run(SAVE_ABORT, tmp).catch(err => console.log(`vsc: could not remove ${tmp}: ${err?.message ?? err}`));
    throw e;
  }
}

// Writes `text` to `path` (on machine `on`, null = this computer) only if the file still holds
// `expected` (null: only if it does not exist). Rejects otherwise, as writeTextFile does.
export function writeFile(path, text, expected, on) {
  return on ? remoteWrite(path, text, expected, on) : writeTextFile(path, text, expected);
}
