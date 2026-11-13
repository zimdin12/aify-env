"""Own one native tty child. All installation collaborators and homes are fixtures."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import time

entry, answer, node = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix="install-terminal-", dir="/tmp") as temp:
    root = Path(temp)
    home, tools, wrapper = root / "home", root / "tools", root / "npm/aify-wrapper"
    for directory in [home, tools, wrapper / "lib", wrapper / "bin", root / "tmp"]:
        directory.mkdir(parents=True, exist_ok=True)

    def write(file, text, executable=False):
        file.write_text(text, encoding="utf-8")
        if executable:
            file.chmod(0o700)

    # Same installed-wrapper seam as the entry tests. No package manager, network,
    # policy action, client runtime or real registry is reached by this witness.
    modules = {
        "connect-http.mjs": "export async function fetchSpec(){return {artifacts:[{id:'fixture-artifact',source:{git:{repo:'fixture/package',revision:'fixture-revision'}}}]}};",
        "service-spec.mjs": "export function validateSpec(){return {ok:true}};export function tupleDigest(){return 'fixture-tuple'};",
        "path-lookup.mjs": "export function resolveOnPath(){return {ok:true}};",
        "channel-install.mjs": "export function channelPolicyReadiness(){return {state:'ready'}};",
        "package-install.mjs": "export function installedCommit(){throw Error('unexpected package query')};export function binFiles(){throw Error('unexpected bins')};export function npmTool(){throw Error('unexpected npm')};export function npmCliBeside(){throw Error('unexpected npm path')};",
        "connect-args.mjs": "export function parseConnectArgs(){return {problem:''}};",
        "connect-report.mjs": "export function connectRecord(){return {pending:[]}};",
        "artifact-catalogue.json": '{"approved":[]}',
    }
    write(wrapper / "package.json", '{"type":"module"}')
    for name, text in modules.items():
        write(wrapper / "lib" / name, text)
    write(tools / "npm", "#!/bin/sh\n[ \"$1 $2\" = 'root -g' ] || exit 97\nprintf '%s\\n' " + str(root / "npm") + "\n", True)
    write(root / "installer.sh", "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$HOME/effects\"\n", True)
    write(wrapper / "bin/aify-wrapper-connect.mjs", """import fs from 'node:fs';
const a=process.argv.slice(2), file=flag=>a[a.indexOf(flag)+1];
if(!a.includes('fixture-tuple')) throw Error('approval missing');
fs.writeFileSync(file('--registry'), JSON.stringify({version:1,services:{'fixture-service':{endpoint:a[1]}}}));
fs.writeFileSync(file('--report-file'),JSON.stringify({installed:[],pending:[]}));
fs.appendFileSync(process.env.HOME+'/effects','connect\\n');
""")
    env = {"PATH": str(tools) + ":/usr/bin:/bin", "HOME": str(home), "USERPROFILE": str(home),
           "TMPDIR": str(root / "tmp"), "AIFY_SERVICE_REGISTRY": str(home / "registry.json"), "TERM": "xterm"}
    version = subprocess.run([node, "--version"], env=env, capture_output=True, text=True, check=True).stdout.strip()
    argv = [node, entry, "--connect", "fixture-service=http://fixture.invalid", "--client", "codex",
            "--installer", "fixture-service=" + str(root / "installer.sh")]
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(home)
        os.execve(argv[0], argv, env)
    output, sent, completed, natural, status = b"", False, None, False, None
    started = time.monotonic()
    cleanup = []
    try:
        while time.monotonic() - started < 15:
            reaped, status_now = os.waitpid(pid, os.WNOHANG)
            if reaped:
                natural, status = True, status_now
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                output += chunk
            if not sent and b"(tuple fixture-tuple)? [y/N] " in output:
                os.write(master, (answer + "\n").encode())
                sent = True
            marker = b"chain: complete" if answer == "yes" else b"chain: not complete"
            if completed is None and marker in output:
                completed = time.monotonic()
            if natural or completed is not None and time.monotonic() - completed >= 3:
                break
    finally:
        # Only our unreaped direct child can be signalled. Forced cleanup is never
        # reported as natural exit, and no process group or unrelated PID is touched.
        if not natural:
            reaped, status_now = os.waitpid(pid, os.WNOHANG)
            if reaped:
                natural, status = True, status_now
            else:
                os.kill(pid, signal.SIGKILL)
                cleanup.append("SIGKILL")
                _, status = os.waitpid(pid, 0)
        os.close(master)
    effects = (home / "effects").read_text().splitlines() if (home / "effects").exists() else []
    print(json.dumps({"platform": sys.platform, "node": version, "promptAnswered": sent,
                      "completionSeen": completed is not None, "naturalExit": natural,
                      "exit": os.waitstatus_to_exitcode(status), "cleanup": cleanup,
                      "afterCompletionMs": round((time.monotonic() - completed) * 1000) if completed else None,
                      "effects": effects, "registry": (home / "registry.json").exists(),
                      "output": output.decode(errors="replace")}))
