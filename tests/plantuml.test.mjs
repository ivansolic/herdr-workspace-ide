// PlantUML: the script that runs a locally installed plantuml, run with the system's sh against a
// stand-in plantuml (its exit codes and what it was given), and against the real one when installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plantumlArgs, PLANTUML_FOLDERS } from "../mods/vsc/lib/scripts.js";
import { diagramKind } from "../mods/vsc/lib/diagrams.js";
import { plantumlFailure, plantumlSource } from "../mods/vsc/lib/documents.js";

const run = ([cmd, args], env) => new Promise(done => execFile(cmd, args, { encoding: "utf8", env }, (error, stdout, stderr) =>
  done({ code: error ? (error.code ?? 1) : 0, stdout, stderr })));

// A plantuml on PATH (or in a folder the script adds) that is not a stand-in.
const installed = spawnSync("sh", ["-c", `PATH=$PATH:${PLANTUML_FOLDERS}; command -v plantuml`], { encoding: "utf8" }).stdout.trim();
const working = installed !== "" && spawnSync(installed, ["-version"], { timeout: 60000 }).status === 0;

test("PlantUML files are diagrams", () => {
  assert.equal(diagramKind("/a/seq.puml"), "plantuml");
  assert.equal(diagramKind("/a/Seq.PlantUML"), "plantuml");
  assert.equal(diagramKind("/a/seq.pu"), "plantuml");
  assert.equal(diagramKind("/a/seq.iuml"), null); // include files are not whole diagrams
});

test("plantumlArgs: absolute paths only", () => {
  const [cmd, args] = plantumlArgs("/c/a.puml", "/c/a.png", 30);
  assert.equal(cmd, "/bin/sh");
  assert.deepEqual(args.slice(2), ["vsc", "/c/a.puml", "/c/a.png", "30"]);
  assert.throws(() => plantumlArgs("a.puml", "/c/a.png", 30));
  assert.throws(() => plantumlArgs("/c/a.puml", "a.png", 30));
  assert.throws(() => plantumlArgs("/c/a.puml", "/c/a.png", 0));
  assert.throws(() => plantumlArgs("/c/a.puml", "/c/a.png", "30; x"));
});

// A stand-in plantuml: records its arguments, stdin and environment, then acts as told by $MODE.
function standIn() {
  const dir = mkdtempSync(join(tmpdir(), "vsc-puml-")), bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  writeFileSync(join(bin, "plantuml"), `#!/bin/sh
printf "%s\\n" "$@" > "${dir}/args"
cat > "${dir}/stdin"
printf "%s|%s" "$PLANTUML_SECURITY_PROFILE" "$JAVA_TOOL_OPTIONS" > "${dir}/env"
case $MODE in
  ok) printf "\\211PNG-ok" ;;
  error) echo "Picked up JAVA_TOOL_OPTIONS: x" >&2; echo "Error line 2 in file: Syntax Error?" >&2; printf "\\211PNG-error"; exit 200 ;;
  other) printf "\\211PNG-partial"; exit 1 ;;
  hang) exec sleep 7351 ;;
  broken) echo "Unable to locate a Java Runtime." >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "plantuml"), 0o755);
  writeFileSync(join(dir, "a.puml"), "@startuml\nKorisnik -> Sustav: prijava čćžšđ\n@enduml\n");
  return { dir, bin };
}

test("the PlantUML script draws with the local plantuml, sandboxed, never through a server", async () => {
  const { dir, bin } = standIn();
  const r = await run(plantumlArgs(join(dir, "a.puml"), join(dir, "a.png"), 30), { PATH: `${bin}:/usr/bin:/bin`, MODE: "ok" });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(dir, "a.png"), "latin1"), "\x89PNG-ok");
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), readFileSync(join(dir, "a.puml"), "utf8"));
  const args = readFileSync(join(dir, "args"), "utf8").trim().split("\n");
  assert.deepEqual(args, ["-tpng", "-charset", "UTF-8", "-pipe"]);
  // SANDBOX: no !include of local files or URLs, no remote themes; set both ways, so a wrapper
  // that drops one still passes the other to Java.
  const [profile, javaOptions] = readFileSync(join(dir, "env"), "utf8").split("|");
  assert.equal(profile, "SANDBOX");
  assert.match(javaOptions, /-DPLANTUML_SECURITY_PROFILE=SANDBOX/);
  assert.match(javaOptions, /-Djava\.awt\.headless=true/);
});

test("PlantUML exit codes: 2 an error in the diagram, 3 plantuml failed, 5 not installed", async () => {
  const { dir, bin } = standIn();
  const bad = await run(plantumlArgs(join(dir, "a.puml"), join(dir, "b.png"), 30), { PATH: `${bin}:/usr/bin:/bin`, MODE: "error" });
  assert.equal(bad.code, 2);
  assert.equal(plantumlFailure(bad.stderr), "Error line 2 in file: Syntax Error?");
  // PlantUML's own form: ERROR, the line counted from @startuml, the message; with one diagram it
  // becomes the file's line, with several it stays relative.
  const said = "Picked up JAVA_TOOL_OPTIONS: x\nERROR\n3\nSyntax Error? (Assumed diagram type: sequence)\n";
  assert.equal(plantumlFailure(said, "\n\n@startuml\nA -> B\nC -> D\nbad\n@enduml\n"), "Line 6: Syntax Error? (Assumed diagram type: sequence)");
  assert.equal(plantumlFailure(said, "@startuml\nA\n@enduml\n@startuml\nB\n@enduml\n"), "Line 3 after @start: Syntax Error? (Assumed diagram type: sequence)");
  const broken = await run(plantumlArgs(join(dir, "a.puml"), join(dir, "c.png"), 30), { PATH: `${bin}:/usr/bin:/bin`, MODE: "broken" });
  assert.equal(broken.code, 3);
  assert.equal(plantumlFailure(broken.stderr), "Unable to locate a Java Runtime.");
  assert.ok(!existsSync(join(dir, "c.png")));
  // Only PlantUML's own 200 is an error in the diagram; another failure that left output is not,
  // and the partial picture is removed.
  assert.ok(!existsSync(join(dir, "b.png")));
  const other = await run(plantumlArgs(join(dir, "a.puml"), join(dir, "e.png"), 30), { PATH: `${bin}:/usr/bin:/bin`, MODE: "other" });
  assert.equal(other.code, 3);
  assert.ok(!existsSync(join(dir, "e.png")));
  // A Java stack trace is cut to its first line.
  assert.equal(plantumlFailure(`java.lang.IllegalStateException: boom\n${"\tat x.y(Z.java:1)\n".repeat(30)}`), "java.lang.IllegalStateException: boom");
  assert.equal(plantumlFailure("x".repeat(1000)).length, 300);
});

test("PlantUML not installed: exit 5", { skip: installed !== "" && `plantuml is installed (${installed})` }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-puml-"));
  writeFileSync(join(dir, "a.puml"), "@startuml\nA -> B\n@enduml\n");
  assert.equal((await run(plantumlArgs(join(dir, "a.puml"), join(dir, "a.png"), 30), { PATH: "/usr/bin:/bin" })).code, 5);
});

test("a plantuml planted in the current folder is never run", async () => {
  const { dir, bin } = standIn();
  const r = await new Promise(done => execFile(...plantumlArgs(join(dir, "a.puml"), join(dir, "d.png"), 30),
    { cwd: bin, env: { PATH: ".:/usr/bin:/bin", MODE: "ok" } }, (error) => done(error ? (error.code ?? 1) : 0)));
  assert.ok(!existsSync(join(dir, "d.png")) || readFileSync(join(dir, "d.png"), "latin1") !== "\x89PNG-ok");
  assert.ok(!existsSync(join(dir, "args")), "the planted plantuml ran");
  assert.ok(r === 5 || installed !== "");
});

test("the real plantuml draws a diagram and reports an error", { skip: !working && "no working plantuml (brew install plantuml)", timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-puml-"));
  writeFileSync(join(dir, "a.puml"), "@startuml\nKorisnik -> Sustav: prijava čćžšđ\n@enduml\n");
  const ok = await run(plantumlArgs(join(dir, "a.puml"), join(dir, "a.png"), 30), process.env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual([...readFileSync(join(dir, "a.png")).subarray(1, 4)], [0x50, 0x4e, 0x47]);
  writeFileSync(join(dir, "bad.puml"), "@startuml\nthis is not ->-> plantuml\n@enduml\n");
  const bad = await run(plantumlArgs(join(dir, "bad.puml"), join(dir, "bad.png"), 30), process.env);
  assert.equal(bad.code, 2, bad.stderr);
  assert.match(plantumlFailure(bad.stderr, readFileSync(join(dir, "bad.puml"), "utf8")), /^Line 2: Syntax Error\?/);
  // Sandboxed: an include of a file next to it (which plain plantuml draws) is refused, so the
  // file's text never ends up in the picture.
  writeFileSync(join(dir, "part.iuml"), "A -> B: tajna\n");
  writeFileSync(join(dir, "inc.puml"), `@startuml\n!include ${join(dir, "part.iuml")}\n@enduml\n`);
  assert.equal(spawnSync("sh", ["-c", `"${installed}" -tpng -pipe < "$1" > "$2"`, "sh", join(dir, "inc.puml"), join(dir, "open.png")]).status, 0);
  const inc = await run(plantumlArgs(join(dir, "inc.puml"), join(dir, "inc.png"), 30), process.env);
  assert.equal(inc.code, 2);
  assert.match(plantumlFailure(inc.stderr), /cannot include/);
});

test("a plantuml that never ends is stopped after the limit (exit 4), nothing left running", { timeout: 30000 }, async () => {
  const { dir, bin } = standIn();
  const started = Date.now();
  const r = await run(plantumlArgs(join(dir, "a.puml"), join(dir, "h.png"), 2), { PATH: `${bin}:/usr/bin:/bin`, MODE: "hang" });
  assert.equal(r.code, 4);
  assert.ok(Date.now() - started < 10000);
  await new Promise(done => setTimeout(done, 300));
  assert.equal(spawnSync("pgrep", ["-f", "sleep 7351"]).status, 1, "the plantuml process is still running");
  assert.ok(!existsSync(join(dir, "h.png")));
  // The work folder is removed too.
  assert.deepEqual(readdirSync(dir).filter(n => n.startsWith("puml.")), []);
});

test("plantumlSource: a leading byte order mark is dropped; an empty diagram is null", () => {
  assert.equal(plantumlSource("\ufeff@startuml\nA -> B\n@enduml\n"), "@startuml\nA -> B\n@enduml\n");
  assert.equal(plantumlSource(" \n\t\n"), null);
  assert.equal(plantumlSource("\ufeff"), null);
});

test("plantuml writes nothing outside a work folder of its own, removed after", { skip: !working && "no working plantuml (brew install plantuml)", timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-puml-")), here = mkdtempSync(join(tmpdir(), "vsc-puml-cwd-"));
  writeFileSync(join(dir, "t.puml"), "@startuml\n!pragma svek_trace on\nclass A\nclass B\nA --> B\n@enduml\n");
  const r = await new Promise(done => execFile(...plantumlArgs(join(dir, "t.puml"), join(dir, "t.png"), 30), { cwd: here, encoding: "utf8" },
    (error, _out, stderr) => done({ code: error ? (error.code ?? 1) : 0, stderr })));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(here), []);
  assert.deepEqual(readdirSync(dir).sort(), ["t.png", "t.puml"]);
});

test("the Java option alone keeps SANDBOX, for a wrapper that drops the environment variable", { skip: !working && "no working plantuml (brew install plantuml)", timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vsc-puml-")), bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  writeFileSync(join(bin, "plantuml"), `#!/bin/sh\nPLANTUML_SECURITY_PROFILE=UNSECURE; export PLANTUML_SECURITY_PROFILE\nexec "${installed}" "$@"\n`);
  chmodSync(join(bin, "plantuml"), 0o755);
  writeFileSync(join(dir, "part.iuml"), "A -> B: tajna\n");
  writeFileSync(join(dir, "inc.puml"), `@startuml\n!include ${join(dir, "part.iuml")}\n@enduml\n`);
  const r = await run(plantumlArgs(join(dir, "inc.puml"), join(dir, "inc.png"), 30), { PATH: `${bin}:/usr/bin:/bin` });
  assert.equal(r.code, 2, r.stderr);
  assert.match(plantumlFailure(r.stderr), /cannot include/);
});
