import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ICON_NAMES } from "../mods/vsc/lib/icons.js";
import { UI_ICONS } from "../mods/vsc/lib/ui-icons.js";

const dir = new URL("../mods/vsc/icons/", import.meta.url);

test("every icon the mod can show has an svg file in Herdr's line style", () => {
  for (const name of [...ICON_NAMES, ...UI_ICONS]) {
    const file = new URL(`${name}.svg`, dir);
    assert.ok(existsSync(file), `missing icons/${name}.svg`);
    const svg = readFileSync(file, "utf8");
    assert.match(svg, /viewBox="0 0 24 24"/, `${name}: 24x24 viewBox`);
    assert.match(svg, /stroke="currentColor"/, `${name}: colored by text_color`);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b/i, `${name}: no fixed colors`);
  }
});
