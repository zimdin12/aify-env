"""One matched named-file control; a pass is non-reproduction, not failure attribution."""
from pathlib import Path
import hashlib
import json
import os
import subprocess

ENV = Path('C:/Users/Administrator/projects/aify-env-task10')
BASE = ENV.with_name('aify-env')
OUT = Path(__file__).resolve().parent / 'named-env-control'
FAILED = 'tests/the-dashboard-plugin-reads-only-what-it-judged.test.js'


def source_state(root):
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    return {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
            'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in tracked if name}}


def run():
    OUT.mkdir(exist_ok=False)
    full = json.loads((OUT.parent / 'successor-full/receipt.json').read_text())
    env = dict(os.environ)
    for key in tuple(env):
        if key.upper() in ('MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL'):
            del env[key]
    env.update({key: value for key, value in full['pins'].items() if value is not None})
    receipt = {'rule': 'Exactly one baseline and candidate selection. Passing means non-reproduction only.',
               'before': {str(root): source_state(root) for root in (BASE, ENV)}, 'runs': []}
    target = OUT / 'receipt.json'
    target.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    for label, root in [('baseline', BASE), ('candidate', ENV)]:
        log = OUT / f'{label}.txt'
        command = [full['node'], 'tests/run-in-a-temp-root.mjs', FAILED]
        with log.open('xb') as output:
            completed = subprocess.run(command, cwd=root, env={**env, 'AIFY_ENV_REPO': str(root)},
                                       stdout=output, stderr=subprocess.STDOUT, check=False)
        receipt['runs'].append({'arm': label, 'command': command, 'cwd': str(root),
                                'exit_code': completed.returncode, 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()})
        target.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        print(label, 'exit=', completed.returncode, flush=True)
    receipt['after'] = {str(root): source_state(root) for root in (BASE, ENV)}
    receipt['source_unchanged'] = receipt['before'] == receipt['after']
    target.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    assert receipt['source_unchanged']


if __name__ == '__main__':
    run()
