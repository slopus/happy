// Runs only inside a disposable, networkless browser-image container. The source is mounted read-only.
// lstat + no symlink following preserves Chromium profile links without escaping either volume.
export const PROFILE_COPY = String.raw`
import os, stat, hashlib, shutil, json, sys

def manifest(root):
    entries = []
    def walk(path, relative):
        st = os.lstat(path)
        mode = stat.S_IMODE(st.st_mode)
        if stat.S_ISLNK(st.st_mode):
            entries.append([relative, 'link', mode, os.readlink(path)])
        elif stat.S_ISDIR(st.st_mode):
            entries.append([relative, 'dir', mode])
            for name in sorted(os.listdir(path)):
                walk(os.path.join(path, name), relative + '/' + name)
        elif stat.S_ISREG(st.st_mode):
            digest = hashlib.sha256()
            with open(path, 'rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''): digest.update(chunk)
            entries.append([relative, 'file', mode, st.st_size, digest.hexdigest()])
        else:
            raise RuntimeError('unsupported profile entry: ' + relative)
    walk(root, '')
    return entries

before = manifest('/from')
if os.listdir('/to'):
    if '--resume' not in sys.argv: raise RuntimeError('target is not empty')
    # Only the journaled, never-admitted partial destination may be reset on explicit resume.
    for name in os.listdir('/to'):
        path = os.path.join('/to', name)
        if os.path.isdir(path) and not os.path.islink(path): shutil.rmtree(path)
        else: os.unlink(path)
shutil.copytree('/from', '/to', symlinks=True, dirs_exist_ok=True)
if before != manifest('/from') or before != manifest('/to'):
    raise RuntimeError('profile copy verification failed')
for root, dirs, files in os.walk('/to', followlinks=False):
    os.chown(root, 10871, 10871, follow_symlinks=False)
    for name in dirs + files: os.chown(os.path.join(root, name), 10871, 10871, follow_symlinks=False)
os.sync()
print(json.dumps({'verified': True, 'sha256': hashlib.sha256(json.dumps(before).encode()).hexdigest()}))
`;
