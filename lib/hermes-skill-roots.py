"""Where the selected Hermes keeps and searches skills, asked of Hermes' own code, read-only.

lib/skill-roots.mjs runs it with that Hermes' Python, from its checkout, with the caller's HERMES_HOME in effect:

    <hermes-agent>/venv/Scripts/python.exe -B hermes-skill-roots.py --cwd <the folder a session would start in>

It prints one JSON line, {"hermesHome", "skillsDir", "searchRoots"}, and exits 0. Any exception prints
{"error", "exception", "phase"} and exits 2: the exception's type and the step, never its message, which can carry a
path or a config value.

Read-only by enforcement: importing Hermes can bootstrap its home (folders, permissions, SOUL.md), and an observer must
not. An audit hook installed before any Hermes module loads refuses every filesystem write, process start and network
call Python reports. A call that changes nothing (a mkdir of a folder that exists, a chmod to the mode a path already
has, an open of the null device) is let through. A Python hook is not an OS-level guarantee about native code.
"""

import argparse
import json
import os
import sys

PHASE = {"now": "start"}

# Starting a process or reaching a network: an update, a sync or a telemetry call would leave the machine.
ESCAPE_EVENTS = {
    "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.startfile",
    "socket.connect", "socket.getaddrinfo", "urllib.Request",
}

# Changing a filesystem. open() is judged by its mode below.
WRITE_EVENTS = {
    "os.mkdir", "os.rmdir", "os.remove", "os.rename", "os.replace", "os.chmod", "os.chown", "os.link",
    "os.symlink", "os.truncate", "os.utime", "shutil.copyfile", "shutil.copymode", "shutil.copystat",
    "shutil.copytree", "shutil.move", "shutil.rmtree", "tempfile.mkstemp", "tempfile.mkdtemp",
}


def is_null_device(target):
    if not isinstance(target, str):
        return False
    return target == os.devnull or (os.name == "nt" and target.lower() == os.devnull.lower())


def changes_nothing(event, args):
    target = str(args[0]) if args else ""
    if event == "os.mkdir" and os.path.isdir(target):
        return True
    if event == "os.chmod" and len(args) > 1 and isinstance(args[1], int):
        try:
            return (os.stat(target).st_mode & 0o7777) == (args[1] & 0o7777)
        except OSError:
            return False
    return False


def hook(event, args):
    if event in ESCAPE_EVENTS:
        raise PermissionError(f"the skill-root probe starts nothing and connects nowhere: {event}")
    if event == "open":
        if args and is_null_device(args[0]):
            return
        mode = args[1] if len(args) > 1 else "r"
        flags = args[2] if len(args) > 2 else 0
        writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
            isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        )
        if not writing:
            return
    elif event not in WRITE_EVENTS:
        return
    if changes_nothing(event, args):
        return
    raise PermissionError(f"the skill-root probe is read-only: {event}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    args = parser.parse_args()

    PHASE["now"] = "guard"
    # Hermes' modules live in its checkout, the working directory at start; this script lives in aify-env.
    sys.path.insert(0, os.path.abspath(os.getcwd()))
    sys.dont_write_bytecode = True
    sys.addaudithook(hook)
    # Project skills depend on the folder a session starts in, so Hermes is asked from there.
    os.chdir(args.cwd)

    PHASE["now"] = "import"
    from hermes_constants import get_hermes_home, get_skills_dir
    from agent.skill_utils import get_all_skills_dirs, get_project_skills_dirs

    PHASE["now"] = "report"
    print(json.dumps({
        "hermesHome": str(get_hermes_home()),
        "skillsDir": str(get_skills_dir()),
        "searchRoots": [str(d) for d in get_all_skills_dirs()] + [str(d) for d in get_project_skills_dirs()],
    }))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"error": "the probe stopped", "exception": type(error).__name__, "phase": PHASE["now"]}))
        sys.exit(2)
