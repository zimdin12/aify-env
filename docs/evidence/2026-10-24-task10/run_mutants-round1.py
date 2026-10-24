"""Bounded refusal sensitivities on the candidate; each source file is restored byte-for-byte."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent

@dataclass(frozen=True)
class Mutation:
    name: str
    source: str
    before: str
    after: str
    test_file: str
    assertion_case: str

MUTATIONS = (
    Mutation('owner-wiring', 'bin/aify-env.mjs', ', owner: agentState.lifecycleOwner', '',
             'tests/the-daemon-sends-agent-state.test.js', 'successful serving/durable boot wires actual sender'),
    Mutation('owner-validation', 'lib/agent-lifecycle.mjs',
             "  if (Object.hasOwn(row, 'owner') && !validOwner(row.owner)) return false;\n", '',
             'tests/lifecycle-journal-integrity.test.js', 'malformed owner refuses reads'),
    Mutation('same-scope', 'lib/agent-lifecycle.mjs', 'exclusiveScope && saved.scope === current.scope &&', 'exclusiveScope &&',
             'tests/lifecycle-owner-recovery.test.js', 'a live concurrent scope retains custody'),
    Mutation('owner-cas', 'lib/agent-lifecycle.mjs',
             '          || JSON.stringify(row.owner) !== JSON.stringify(before.owner)\n', '',
             'tests/lifecycle-owner-recovery.test.js', 'recovery rereads ownership under the lock'),
    Mutation('terminal-cas', 'lib/agent-lifecycle.mjs', "row?.phase !== 'pending' || row.intent", 'row.intent',
             'tests/lifecycle-owner-recovery.test.js', 'recovery preserves a result completed'),
)

class MutationRunner:
    def run(self):
        node = shutil.which('node')
        assert node
        env = dict(os.environ)
        scratch = Path('C:/Users/Administrator/AppData/Local/hermes/cache/scratch/task10')
        for key in ('TMPDIR', 'TEMP', 'TMP'):
            env[key] = str(scratch)
        results = []
        for mutation in MUTATIONS:
            source = ROOT / mutation.source
            original = source.read_bytes()
            before, after = mutation.before.encode(), mutation.after.encode()
            assert original.count(before) == 1, mutation.name
            command = [node, 'tests/run-in-a-temp-root.mjs', mutation.test_file]
            log = EVIDENCE / f'mutant-{mutation.name}.txt'
            try:
                source.write_bytes(original.replace(before, after, 1))
                with log.open('xb') as output:
                    result = subprocess.run(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
            finally:
                source.write_bytes(original)
                assert source.read_bytes() == original
            text = log.read_text(encoding='utf-8', errors='replace')
            failed = [line for line in text.splitlines() if line.startswith('not ok ')]
            detected = result.returncode != 0 and any(mutation.assertion_case in line for line in failed)
            assert detected and 'ERR_ASSERTION' in text, (mutation.name, result.returncode, failed)
            results.append({'mutation': mutation.name, 'command': command, 'exit': result.returncode,
                            'expected_case': mutation.assertion_case, 'failed_cases': failed,
                            'detected': detected, 'restored_sha256': hashlib.sha256(original).hexdigest(),
                            'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()})
            print(f'{mutation.name}: expected assertion detected, original bytes restored', flush=True)
        (EVIDENCE / 'mutation-receipt.json').write_text(json.dumps(results, indent=2), encoding='utf-8', newline='\n')

if __name__ == '__main__':
    MutationRunner().run()
