# Resume probe (2026-10-28)

Does a resumed Claude conversation take a changed `--append-system-prompt-file`? The results and the table are in
[`docs/0.9/instructions-at-launch.md`](../../0.9/instructions-at-launch.md).

`probe-read.mjs <session.jsonl>` prints, for each request recorded in a Claude Code session file, which sentinel the
recorded system blocks carry and each reply's cache usage. It reads only the file it is given.

The four launches, each in the same new empty folder, with `-p --model haiku` and the agent's identity unset
(`env -u AIFY_AGENT_ID -u AIFY_AGENT_LEASE -u AIFY_ENV_INSTANCE -u AIFY_LIFETIME`):

1. `--append-system-prompt-file A.txt` (sentinel `ALPHA-7F3C`), starting session S;
2. `--resume S --append-system-prompt-file B.txt` (sentinel `BRAVO-91D2`);
3. as 2, plus `--system-prompt-snapshot off`;
4. 3 again, after a commit in the folder's git repo.

The session file was deleted after it was read, so this cannot be re-read; re-running needs the operator's approval,
because it uses their login.
