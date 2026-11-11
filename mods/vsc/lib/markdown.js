// Markdown preview safety: a remote image would be fetched just by opening a file (an IP leak and
// a read receipt for whoever wrote it). Markdown has too many ways to write an image and an address
// (references, shortcuts, escapes, entities, HTML) to tell local from remote reliably, so every
// image marker is neutralised and images show as text until "Load images" shows the original.
// (Local images cannot be shown anyway: the app loads images only from its own folder.)
// Pure: no herdr imports, so it runs under node --test.

export function holdImages(md) {
  let blocked = 0;
  const text = md
    .replace(/(\\*)!\[/g, (all, slashes) => slashes.length % 2 ? all : (blocked++, `${slashes}\\![`))
    .replace(/<(img|image)\b/gi, (_all, tag) => (blocked++, `&lt;${tag}`));
  return { text, blocked };
}
