"""One final five-suite candidate campaign with matched bridge/env baseline controls."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ENV = Path(__file__).resolve().parents[3]
BASE = ENV.with_name('aify-env')
COMMS = ENV.with_name('aify-comms-task5')
WRAPPER = ENV.with_name('aify-wrapper')
OUT = Path(__file__).resolve().parent / 'successor-full'
SCRATCH = Path('C:/Users/Administrator/AppData/Local/hermes/cache/scratch/task10-full')

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()

def source_state():
    result = {}
    for name, root in [('candidate_env', ENV), ('baseline_env', BASE), ('comms', COMMS), ('wrapper', WRAPPER)]:
        paths = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).split(b'\0')
        digest = hashlib.sha256()
        count = 0
        for raw in sorted(p for p in paths if p):
            relative = raw.decode('utf-8')
            file = root / relative
            if not file.is_file():
                raise RuntimeError(f'tracked source not readable as a file: {file}')
            data = file.read_bytes()
            digest.update(raw + b'\0' + hashlib.sha256(data).digest())
            count += 1
        result[name] = {'path': str(root), 'head': git(root, 'rev-parse', 'HEAD'),
                        'tracked_files': count, 'raw_population_sha256': digest.hexdigest()}
    result['candidate_staged_tree'] = git(ENV, 'write-tree')
    return result

class SuiteCampaign:
    def run(self):
        OUT.mkdir(exist_ok=False)
        SCRATCH.mkdir(exist_ok=True)
        node, bash = shutil.which('node'), shutil.which('bash')
        assert node and bash
        env = dict(os.environ, AIFY_ENV_REPO=str(ENV), AIFY_WRAPPER_REPO=str(WRAPPER),
                   TMPDIR=str(SCRATCH), TEMP=str(SCRATCH), TMP=str(SCRATCH),
                   AIFY_SHADOW_PYTHON=sys.executable, PYTHONPATH=os.pathsep.join(sys.path))
        for key in list(env):
            if key.upper() in ('MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL'):
                del env[key]
        receipt = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   'before': source_state(), 'python': sys.executable, 'node': node, 'shell': bash,
                   'pins': {key: env.get(key) for key in ('TMPDIR', 'TEMP', 'TMP', 'PYTHONPATH', 'AIFY_SHADOW_PYTHON',
                             'AIFY_ENV_REPO', 'AIFY_WRAPPER_REPO', 'MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL')}, 'runs': []}
        suites = [
            ('baseline-bridge', COMMS / 'mcp/stdio', [node, 'tests/run-all.mjs'], BASE),
            ('baseline-env', BASE, [bash, '-c', 'npm test'], BASE),
            ('candidate-python', COMMS, [sys.executable, '-m', 'pytest', 'service/tests', 'scripts/tests', '-q', '-n', '8', '--dist', 'loadfile'], ENV),
            ('candidate-bridge', COMMS / 'mcp/stdio', [node, 'tests/run-all.mjs'], ENV),
            ('candidate-dashboard', COMMS / 'service/new_dashboard', [node, '--test', *sorted(p.name for p in (COMMS / 'service/new_dashboard').glob('*.test.mjs'))], ENV),
            ('candidate-wrapper', WRAPPER, [bash, '-c', 'npm test'], ENV),
            ('candidate-env', ENV, [bash, '-c', 'npm test'], ENV),
        ]
        target = OUT / 'receipt.json'
        target.write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
        for name, cwd, command, source in suites:
            child_env = dict(env, AIFY_ENV_REPO=str(source))
            log = OUT / f'{name}.txt'
            print('START', name, flush=True)
            started = time.monotonic()
            with log.open('xb') as stream:
                completed = subprocess.run(command, cwd=cwd, env=child_env, stdout=stream, stderr=subprocess.STDOUT)
            receipt['runs'].append({'suite': name, 'cwd': str(cwd), 'command': command, 'env_repo': str(source),
                                    'exit_code': completed.returncode, 'elapsed_s': round(time.monotonic() - started, 3),
                                    'log': str(log), 'log_sha256': hashlib.sha256(log.read_bytes()).hexdigest()})
            target.write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
            print('END', name, 'exit=' + str(completed.returncode), flush=True)
        receipt['after'] = source_state()
        receipt['source_unchanged'] = receipt['before'] == receipt['after']
        receipt['candidate_all_five_passed'] = all(r['exit_code'] == 0 for r in receipt['runs'] if r['suite'].startswith('candidate-'))
        target.write_text(json.dumps(receipt, indent=2), encoding='utf-8', newline='\n')
        print('COMPLETE source_unchanged=' + str(receipt['source_unchanged']) + ' candidate_all_five_passed=' + str(receipt['candidate_all_five_passed']), flush=True)
        return 0 if receipt['source_unchanged'] and receipt['candidate_all_five_passed'] else 1

if __name__ == '__main__':
    raise SystemExit(SuiteCampaign().run())
