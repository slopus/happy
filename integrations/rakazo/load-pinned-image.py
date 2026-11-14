#!/usr/bin/env python3
"""Load the pinned public OCI image through the host's proxy, without changing Docker proxy settings."""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import platform
import subprocess
import tarfile
import time
import urllib.request

args = argparse.ArgumentParser()
args.add_argument('--cache-directory', required=True)
args.add_argument('--component', choices=['app', 'postgres'], default='app')
options = args.parse_args()
cache = pathlib.Path(options.cache_directory)
if not cache.is_absolute():
    raise SystemExit('The image cache directory must be absolute')
cache.mkdir(parents=True, exist_ok=True)
lock = json.loads(pathlib.Path(__file__).with_name('upstream.lock.json').read_text())
source_image = lock['appImage'] if options.component == 'app' else lock['postgresImage']
repository, index_digest = source_image.split('@')
if options.component == 'postgres':
    registry, image = 'registry-1.docker.io', 'library/postgres'
    token_url = 'https://auth.docker.io/token?service=registry.docker.io&scope=repository:' + image + ':pull'
else:
    registry, image = repository.split('/', 1)
    token_url = 'https://' + registry + '/token?service=' + registry + '&scope=repository:' + image + ':pull'
base = 'https://' + registry + '/v2/' + image + '/'
with urllib.request.urlopen(token_url, timeout=30) as response:
    token = json.load(response)['token']
headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json'}

def checked_bytes(kind, digest):
    request = urllib.request.Request(base + kind + '/' + digest, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read()
    if 'sha256:' + hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Registry content digest mismatch')
    return data

index_data = checked_bytes('manifests', index_digest)
index = json.loads(index_data)
architecture = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}.get(platform.machine())
descriptor = next(item for item in index['manifests'] if item.get('platform', {}).get('os') == 'linux' and item['platform'].get('architecture') == architecture)
manifest_data = checked_bytes('manifests', descriptor['digest'])
manifest = json.loads(manifest_data)
config_data = checked_bytes('blobs', manifest['config']['digest'])
config = json.loads(config_data)
if options.component == 'app' and config.get('config', {}).get('Labels', {}).get('org.opencontainers.image.revision') != lock['commit']:
    raise ValueError('Published image revision does not match the pinned source')
identity = options.component + '-' + (lock['commit'] if options.component == 'app' else index_digest.removeprefix('sha256:'))
layout = cache / identity
blobs = layout / 'blobs' / 'sha256'
blobs.mkdir(parents=True, exist_ok=True)
for digest, data in [(descriptor['digest'], manifest_data), (manifest['config']['digest'], config_data)]:
    (blobs / digest.removeprefix('sha256:')).write_bytes(data)

def file_sha256(file):
    checksum = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()

def download_once(layer):
    digest = layer['digest']; destination = blobs / digest.removeprefix('sha256:')
    if destination.exists() and destination.stat().st_size == layer['size'] and file_sha256(destination) == digest.removeprefix('sha256:'):
        return
    temporary = destination.with_suffix('.partial')
    request = urllib.request.Request(base + 'blobs/' + digest, headers=headers)
    deadline = time.monotonic() + 300
    checksum = hashlib.sha256(); size = 0
    with urllib.request.urlopen(request, timeout=30) as response, temporary.open('wb') as output:
        while chunk := response.read(1024 * 1024):
            if time.monotonic() > deadline:
                raise TimeoutError('Image layer exceeded the download deadline')
            checksum.update(chunk); size += len(chunk); output.write(chunk)
    if checksum.hexdigest() != digest.removeprefix('sha256:') or size != layer['size']:
        temporary.unlink(missing_ok=True)
        raise ValueError('Image layer checksum/length mismatch')
    temporary.replace(destination)
    print(json.dumps({'downloadedMB': round(size / 1_000_000, 1)}), flush=True)

def download(layer):
    for attempt in range(3):
        try:
            return download_once(layer)
        except (OSError, TimeoutError) as error:
            if attempt == 2:
                raise
            print(json.dumps({'transferRetry': attempt + 1, 'reason': type(error).__name__}), flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
    list(executor.map(download, manifest['layers']))
(layout / 'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')
descriptor['annotations'] = {'org.opencontainers.image.ref.name': repository + (':' + lock['appTag'] if options.component == 'app' else '-paws-pinned')}
(layout / 'index.json').write_text(json.dumps({'schemaVersion': 2, 'manifests': [descriptor]}))
archive = cache / (identity + '.oci.tar')
with tarfile.open(archive, 'w') as output:
    for file in layout.rglob('*'):
        if file.is_file(): output.add(file, arcname=str(file.relative_to(layout)))
subprocess.run(['docker', 'load', '--input', str(archive)], check=True)
print(json.dumps({'manifestDigest': descriptor['digest'], 'configDigest': manifest['config']['digest'], 'sourceImage': source_image, 'sourceCommit': lock['commit'] if options.component == 'app' else None, 'archive': str(archive)}))
