"""Replay private Linux native-lock qualification. Never touches other containers.
Run from this checkout with Python; needs Docker Linux engine and network.
Raw receipts remain in .check-output/activity-flock-linux-6, never versioned.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.check-output/activity-flock-linux-6' / ('run-' + str(time.time_ns()))
WRAPPER = Path('C:/Users/Administrator/projects/wrapper-activity-loss-review-6')
FROZEN = '0e6f1f4178544ddf95840217534d27bc1fdec103'
WRAPPER_HEAD = '0de08cbd1ee6faf3a484bba2fb514ed0d117ce92'


def call(args, name, check=True):
    result = subprocess.run(args, cwd=ROOT, capture_output=True)
    (OUT / (name + '.stdout')).write_bytes(result.stdout)
    (OUT / (name + '.stderr')).write_bytes(result.stderr)
    (OUT / (name + '.json')).write_text(json.dumps({'args': args, 'exit': result.returncode}))
    if check and result.returncode:
        raise RuntimeError(f'{name}: exit {result.returncode}: {result.stderr.decode(errors="replace")}')
    return result


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if (OUT / 'started.json').exists():
        raise RuntimeError('Evidence already exists; choose a fresh owned clone, never overwrite receipts')
    (OUT / 'started.json').write_text(json.dumps({'epoch': time.time(), 'root': str(ROOT)}))
    head = call(['git', 'rev-parse', 'HEAD'], 'source-head').stdout.decode().strip()
    call(['git', 'merge-base', '--is-ancestor', FROZEN, 'HEAD'], 'frozen-ancestor')
    frozen_diff = call(['git', 'diff', FROZEN, '--', 'lib', 'package.json', 'package-lock.json', 'tests/run-in-a-temp-root.mjs'], 'frozen-product-diff').stdout
    if frozen_diff:
        raise RuntimeError('Product or maintained runner differs from frozen parent')
    wh = call(['git', '-C', str(WRAPPER), 'rev-parse', 'HEAD'], 'wrapper-head').stdout.decode().strip()
    if wh != WRAPPER_HEAD:
        raise RuntimeError('Wrapper source changed')
    archive = call(['git', '-C', str(WRAPPER), 'archive', WRAPPER_HEAD, 'lib'], 'wrapper-archive').stdout
    (OUT / 'wrapper.tar').write_bytes(archive)
    with tarfile.open(OUT / 'wrapper.tar') as stream:
        stream.extractall(OUT / 'wrapper', filter='data')
    hashes = {}
    for folder in ['lib', 'tests', 'docs/evidence']:
        for file in (ROOT / folder).rglob('*'):
            if file.is_file():
                hashes[file.relative_to(ROOT).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    for file in [ROOT / 'package.json', ROOT / 'package-lock.json']:
        hashes[file.name] = hashlib.sha256(file.read_bytes()).hexdigest()
    (OUT / 'source-hashes.json').write_text(json.dumps(hashes, indent=2))
    with tarfile.open(OUT / 'executed-source.tar', 'w') as stream:
        for folder in ['lib', 'tests']:
            stream.add(ROOT / folder, arcname=folder)
        for file in ['package.json', 'package-lock.json', 'docs/evidence/activity-flock-linux-6.py', 'docs/evidence/activity-flock-linux-6.mjs']:
            stream.add(ROOT / file, arcname=file)
    call(['docker', 'version', '--format', '{{json .Server}}'], 'docker-server')
    call(['docker', 'image', 'inspect', 'node:22-bookworm'], 'cached-node22-floating')
    results = []
    for version in ['22.20.0', '26.7.0']:
        tag = f'node:{version}-bookworm'
        lane = OUT / version
        lane.mkdir()
        call(['docker', 'pull', tag], f'{version}-pull')
        image = json.loads(call(['docker', 'image', 'inspect', tag], f'{version}-image').stdout)[0]
        name = 'proof-activity-flock-linux-6-' + version.replace('.', '-') + '-' + str(int(time.time()))
        args = ['docker', 'create', '--name', name, '--label', 'proof=activity-flock-linux-6',
                '--mount', f'type=bind,source={ROOT},target=/source,readonly',
                '--workdir', '/work', image['Id'], '/usr/local/bin/node',
                '/source/docs/evidence/activity-flock-linux-6.mjs', version, '/source/' + OUT.relative_to(ROOT).as_posix()]
        cid = call(args, f'{version}-create').stdout.decode().strip()
        (lane / 'owned-container.json').write_text(json.dumps({'id': cid, 'name': name, 'image': image['Id']}))
        try:
            call(['docker', 'inspect', cid], f'{version}-container-before')
            run = call(['docker', 'start', '--attach', cid], f'{version}-run', check=False)
            call(['docker', 'inspect', cid], f'{version}-container-after')
            call(['docker', 'cp', cid + ':/evidence/.', str(lane)], f'{version}-copy')
            record = json.loads((lane / 'result.json').read_text())
            results.append({'version': version, 'dockerExit': run.returncode, **record})
        finally:
            call(['docker', 'rm', cid], f'{version}-remove')
            # Same inspect instrument finds an existing immutable image as its positive control.
            call(['docker', 'image', 'inspect', image['Id']], f'{version}-cleanup-positive')
            gone = call(['docker', 'container', 'inspect', cid], f'{version}-cleanup-negative', check=False)
            if gone.returncode == 0 or cid not in gone.stderr.decode():
                raise RuntimeError('Owned container removal was not verified')
    post_hashes = {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in hashes}
    (OUT / 'source-hashes-after.json').write_text(json.dumps(post_hashes, indent=2))
    if hashes != post_hashes:
        raise RuntimeError('Source changed during qualification')
    (OUT / 'summary.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))
    if not all(item.get('qualified') and item['dockerExit'] == 0 for item in results):
        raise RuntimeError('Qualification failed; inspect preserved receipts')


if __name__ == '__main__':
    main()
