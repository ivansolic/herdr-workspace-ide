// Text sent to another machine for saving: UTF-8 bytes, the POSIX cksum the save script compares,
// and argument-sized chunks. Pure: no herdr imports, so it runs under node --test.

export function utf8Bytes(text) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  return c >>> 0;
});

// "crc size", as `cksum < file` prints it: CRC-32 (POSIX) over the bytes, then over the length.
export function posixCksum(text) {
  const bytes = utf8Bytes(text);
  let crc = 0;
  const add = (b) => { crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0; };
  for (const b of bytes) add(b);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) add(n & 0xff);
  return `${(~crc) >>> 0} ${bytes.length}`;
}

// Pieces of at most `max` UTF-16 units, never splitting an emoji's surrogate pair. Each goes in one
// program argument: Linux takes at most 128 KiB per argument, and a unit is at most 3 UTF-8 bytes.
export function textChunks(text, max) {
  const chunks = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + max, text.length);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}
