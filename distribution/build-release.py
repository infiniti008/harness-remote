#!/usr/bin/env python3
"""Assemble a candidate from allowlisted code/assets, never from a user's agent home."""
from pathlib import Path
import argparse, base64, gzip, hashlib, io, json, shutil, subprocess, tarfile, tempfile, urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEPENDENCIES = {
    'codex-acp': {
        'version': '1.13.1',
        'url': 'https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-1.13.1.tgz',
        'sha256': '93e2f215d9d68eb43afc98f46038eecf973996c0c522a8915249148b6ea35e01',
    },
    'qrcode-terminal': {
        'version': '0.12.0',
        'url': 'https://registry.npmjs.org/qrcode-terminal/-/qrcode-terminal-0.12.0.tgz',
        'sha512': 'EXtzRZmC+YGmGlDFbXKxQiMZNwCLEO6BANKXG4iCtSIM0yqc/pappSx3RIKr4r0uh5JsBckOXeKrB3Iz7mdQpQ==',
    },
}


def verified_package(name):
    spec = DEPENDENCIES[name]
    cache = ROOT / '.vendor-cache'
    cache.mkdir(exist_ok=True)
    file = cache / f'{name}-{spec["version"]}.tgz'
    if file.exists():
        blob = file.read_bytes()
    else:
        with urllib.request.urlopen(spec['url'], timeout=30) as response:
            blob = response.read(32 * 1024 * 1024 + 1)
    if len(blob) > 32 * 1024 * 1024:
        raise RuntimeError('Dependency archive exceeds build download budget')
    valid = hashlib.sha256(blob).hexdigest() == spec['sha256'] if 'sha256' in spec else base64.b64encode(hashlib.sha512(blob).digest()).decode() == spec['sha512']
    if not valid:
        raise RuntimeError(f'Checksum mismatch for {name}; refusing to assemble')
    file.write_bytes(blob)
    return blob


def extract_package(blob, destination, selected=None):
    with tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz') as archive:
        for item in archive.getmembers():
            parts = Path(item.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or item.issym() or item.islnk():
                raise RuntimeError('Unsafe dependency archive path')
            relative = Path(*parts[1:])
            if not item.isfile() or (selected and str(relative) not in selected):
                continue
            file = destination / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(archive.extractfile(item).read())
            file.chmod(item.mode & 0o755)


def pack(source, output, prefix, epoch):
    with output.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for file in sorted(source.rglob('*')):
                if file.is_symlink():
                    raise RuntimeError('Unexpected symlink in release staging')
                if not file.is_file():
                    continue
                info = archive.gettarinfo(str(file), arcname=f'{prefix}/{file.relative_to(source)}')
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = epoch
                info.mode = 0o755 if file.stat().st_mode & 0o111 else 0o644
                with file.open('rb') as data:
                    archive.addfile(info, data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--allow-dirty', action='store_true', help='development artifacts only')
    options = parser.parse_args()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT).strip())
    if dirty and not options.allow_dirty:
        raise RuntimeError('Commit reviewed source before building a release')
    if not (ROOT / 'web/dist/index.html').exists():
        raise RuntimeError('Build and test web/dist before packaging')
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['version']
    if json.loads((ROOT / 'web/package.json').read_text())['version'] != version:
        raise RuntimeError('Gateway and web package versions must agree before packaging')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    epoch = int(subprocess.check_output(['git', 'show', '-s', '--format=%ct', 'HEAD'], cwd=ROOT, text=True))
    out = ROOT / 'release' / version
    out.mkdir(parents=True, exist_ok=True)
    manifest = {'version': version, 'channel': 'candidate', 'commit': commit, 'dirty': dirty,
        'upstreamCommit': '4463fcfa02d35c77177b762f04ba6841fc168107',
        'testedRuntime': {'node': '24.21.0', 'codex': '0.163.0', 'codex-acp': '1.13.1'},
        'historyProtocol': 1, 'nativeCodexBundled': False, 'dependencies': DEPENDENCIES,
        'nativeProfile': {'name': 'core', 'disabledDiscoveryFeatures': ['plugins', 'apps', 'tool_suggest']}}
    with tempfile.TemporaryDirectory(dir=out) as temp:
        stage = Path(temp) / 'bundle'
        stage.mkdir()
        for name in ['package.json', 'package-lock.json', 'LICENSE', 'README.md']:
            shutil.copy2(ROOT / name, stage / name)
        shutil.copytree(ROOT / 'bridge/src', stage / 'bridge/src')
        shutil.copytree(ROOT / 'bridge/scripts', stage / 'bridge/scripts')
        shutil.copytree(ROOT / 'web/dist', stage / 'web')
        (stage / 'distribution').mkdir()
        (stage / 'docs').mkdir()
        for name in ['LOCAL_2_RETEST.md', 'LOCAL_2_VALIDATION.md', 'COMPACT_WORKSPACE.md', 'LOCAL_4_NATIVE_SAFETY.md', 'LOCAL_4_RETEST.md', 'LOCAL_4_VALIDATION.md', 'LOCAL_5_RETEST.md', 'LOCAL_5_VALIDATION.md', 'LOCAL_6_RETEST.md', 'LOCAL_6_VALIDATION.md', 'MCP_SETUP.md', 'LOCAL_6_ENDURANCE.md', 'LOCAL_7_RETEST.md', 'LOCAL_8_RETEST.md', 'HA_DEPLOYMENT_PATH.md']:
            shutil.copy2(ROOT / 'docs' / name, stage / 'docs' / name)
        (stage / 'docs/previews').mkdir()
        for name in ['compact-desktop.png', 'compact-phone.png', 'local4-desktop.png', 'local4-phone.png', 'local5-menu-desktop.png', 'local5-menu-phone.png', 'local7-image-desktop.png', 'local7-image-phone.png']:
            shutil.copy2(ROOT / 'docs/previews' / name, stage / 'docs/previews' / name)
        shutil.copy2(ROOT / 'distribution/run.mjs', stage / 'distribution/run.mjs')
        shutil.copy2(ROOT / 'distribution/harness-remote.service', stage / 'distribution/harness-remote.service')
        shutil.copy2(ROOT / 'distribution/README.md', stage / 'README-LOCAL.md')
        extract_package(verified_package('qrcode-terminal'), stage / 'node_modules/qrcode-terminal')
        extract_package(verified_package('codex-acp'), stage / 'vendor/codex-acp', {'dist/index.js', 'package.json', 'LICENSE', 'README.md'})
        (stage / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'web/release.json').write_text(json.dumps(manifest, indent=2) + '\n')
        # Check the runtime module from the actual staged layout, not another hardcoded version.
        health = json.loads(subprocess.check_output([
            'node', '--input-type=module', '-e',
            'const {LOCAL_RELEASE_INFO}=await import(process.argv[1]);console.log(JSON.stringify(LOCAL_RELEASE_INFO))',
            (stage / 'bridge/src/local-release-info.js').as_uri()
        ], cwd=stage, text=True))
        if health != {'harnessVersion': version, 'releaseChannel': manifest['channel'], 'historyProtocol': manifest['historyProtocol']}:
            raise RuntimeError('Staged authenticated health metadata disagrees with release manifest')
        pack(stage, out / f'harness-local-{version}.tgz', f'harness-local-{version}', epoch)
        pack(stage / 'web', out / f'harness-web-{version}.tgz', f'harness-web-{version}', epoch)
    (out / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
    sums = [f'{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}' for file in sorted(out.iterdir()) if file.is_file() and file.name != 'SHA256SUMS']
    (out / 'SHA256SUMS').write_text('\n'.join(sums) + '\n')
    print(json.dumps({'output': str(out), 'version': version, 'commit': commit, 'dirty': dirty}))


if __name__ == '__main__':
    main()
