/**
 * PTY server started inside the computer beside the screen gateway. Websockify relays each
 * websocket to one Unix socket connection, which gets its own login shell. Output is raw
 * bytes; input arrives as `[kind:u8][length:u32be][payload]` frames (see contracts/terminal).
 * Per-session files live in the state directory, which is removed when the server stops.
 */
export const TERMINAL_SERVER_PROGRAM = `import fcntl, glob, os, pty, pwd, select, signal, socket, struct, sys, tempfile, termios

path, cwd, state = sys.argv[1], sys.argv[2], sys.argv[3]
MAX_FRAME = 1 << 20

def identity(env):
    # Docker on macOS runs the computer as the host uid (e.g. 501), which has no passwd entry.
    # Name it for the shell through nss_wrapper when available, without touching /etc/passwd.
    try:
        pwd.getpwuid(os.getuid())
        return env, []
    except KeyError:
        pass
    env = dict(env, USER="rakazo", LOGNAME="rakazo")
    libraries = glob.glob("/usr/lib/*/libnss_wrapper.so") + glob.glob("/usr/lib/libnss_wrapper.so")
    if not libraries:
        return env, []
    uid, gid, home = os.getuid(), os.getgid(), env.get("HOME", "/")
    with open("/etc/passwd") as source:
        passwd = source.read()
    with open("/etc/group") as source:
        group = source.read()
    passwd += "rakazo:x:%d:%d:Rakazo:%s:/bin/bash\\n" % (uid, gid, home)
    if not any(line.split(":")[2:3] == [str(gid)] for line in group.splitlines()):
        group += "rakazo:x:%d:\\n" % gid
    names = {}
    for kind, content in (("passwd", passwd), ("group", group)):
        handle, name = tempfile.mkstemp(prefix=kind + "-", dir=state)
        with os.fdopen(handle, "w") as target:
            target.write(content)
        names[kind] = name
    return dict(
        env,
        LD_PRELOAD=libraries[0],
        NSS_WRAPPER_PASSWD=names["passwd"],
        NSS_WRAPPER_GROUP=names["group"],
    ), list(names.values())

def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]

def serve(conn):
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    # Stopping the terminal signals every session; unwind so its files are removed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    env, temporary = identity(dict(os.environ, TERM="xterm-256color"))
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
        except OSError:
            os.chdir(os.path.expanduser("~"))
        shell = env.get("SHELL") or "/bin/bash"
        os.execvpe(shell, [shell, "-l"], env)
    pending = b""
    try:
        while True:
            ready = select.select([conn, fd], [], [])[0]
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                conn.sendall(data)
            if conn in ready:
                data = conn.recv(65536)
                if not data:
                    break
                pending += data
                while len(pending) >= 5:
                    kind = pending[0]
                    size = struct.unpack(">I", pending[1:5])[0]
                    if size > MAX_FRAME:
                        return
                    if len(pending) < 5 + size:
                        break
                    payload, pending = pending[5:5 + size], pending[5 + size:]
                    if kind == 0:
                        write_all(fd, payload)
                    elif kind == 1 and len(payload) == 4:
                        cols, rows = struct.unpack(">HH", payload)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    finally:
        try:
            os.killpg(pid, signal.SIGHUP)
        except OSError:
            pass
        os.close(fd)
        conn.close()
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        for name in temporary:
            try:
                os.unlink(name)
            except OSError:
                pass

try:
    os.unlink(path)
except FileNotFoundError:
    pass
os.makedirs(state, mode=0o700, exist_ok=True)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
previous = os.umask(0o077)
server.bind(path)
os.umask(previous)
server.listen(8)
signal.signal(signal.SIGCHLD, signal.SIG_IGN)
while True:
    conn = server.accept()[0]
    if os.fork() == 0:
        server.close()
        try:
            serve(conn)
        finally:
            os._exit(0)
    conn.close()
`;
