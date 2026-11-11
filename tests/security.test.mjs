import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretFile, isPrivateMode } from "../mods/vsc/lib/editing.js";
import { holdImages } from "../mods/vsc/lib/markdown.js";

test("more secret files, by name and by folder", () => {
  for (const p of ["/p/.envrc", "/p/prod.tfvars", "/p/terraform.tfstate", "/p/secrets.yaml", "/p/secret.json",
    "/h/.kube/config", "/h/.docker/config.json", "/h/.ssh/config", "/h/.ssh/id_ed25519_sk", "/h/.vault-token",
    "/p/key.gpg", "/p/key.asc", "/p/vpn.ovpn", "/h/.s3cfg", "/h/.boto", "/h/.aws/credentials", "/h/.aws/config"])
    assert.equal(isSecretFile(p), true, p);
  for (const p of ["/p/config.ts", "/p/app/config.json", "/p/identity.ts", "/p/secretary.md", "/p/docker-compose.yml"])
    assert.equal(isSecretFile(p), false, p);
});

test("a file nobody else may read counts as private", () => {
  assert.equal(isPrivateMode("600"), true);
  assert.equal(isPrivateMode("400"), true);
  assert.equal(isPrivateMode("700"), true);
  assert.equal(isPrivateMode("640"), false);
  assert.equal(isPrivateMode("644"), false);
  assert.equal(isPrivateMode("604"), false);
  assert.equal(isPrivateMode(null), false);
  assert.equal(isPrivateMode("garbage"), false);
});

// No image loads in a preview until the user asks: every image marker is neutralised, whatever
// the document contains, so no way of writing an address or an image can slip through.
const neutral = (md) => {
  const { text } = holdImages(md);
  return !/!\[/.test(text.replace(/\\!\[/g, "")) && !/<(img|image)\b/i.test(text);
};

test("images are neutralised, in every form", () => {
  const cases = [
    "a ![logo](https://x.io/l.png) b",
    "![p](//cdn.x/p.png)",
    'x <img src="https://t/p.gif" alt="t"> y',
    "<IMG SRC='http://t/p'>",
    "![logo][l]\n\n[l]: https://x.io/l.png",
    "![logo]\n\n[logo]: https://evil/p.png",
    "![a [b] c](https://evil/p.png)",
    "![x][Foo  Bar]\n\n[foo bar]: https://evil/p.png",
    "> [r]: https://evil/p.png\n\n![x][r]",
    "<img src=https://evil/p.png>",
    "\\`![x](https://evil/p.png)\\`",
    "text ``` ![x](https://evil/p.png)",
    "![x](https:\\/\\/evil.com/p.png)",
    "![x](https:&#47;&#47;evil.com/p.png)",
    "<image src=https://evil/p.png>",
    "![local](img/a.png)",
  ];
  for (const md of cases) assert.ok(neutral(md), md);
});

test("a document without images is left exactly as written", () => {
  const md = "# Title\n\n[a link](https://x.io) and `code`";
  assert.deepEqual(holdImages(md), { text: md, blocked: 0 });
});

test("the count says how many images were held back", () => {
  assert.equal(holdImages("![a](https://x/a) ![b](https://x/b) <img src=https://x/c>").blocked, 3);
});
