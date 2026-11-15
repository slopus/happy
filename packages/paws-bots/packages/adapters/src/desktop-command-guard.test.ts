import { describe, expect, it } from "vitest";
import {
  desktopGuardApplies,
  desktopProtectionGuardMessage,
  isProtectedComputerLifecycleCommand,
  protectedComputerLifecycleRefusal,
} from "./desktop-command-guard.js";
import { protectedActivateScriptWriteRefusal } from "./desktop-guard-words.js";

describe("computer lifecycle command guard", () => {
  it("rejects commands that can destroy a graphical bot's desktop", () => {
    for (const command of [
      "pkill chromium",
      "killall chrome",
      "kill -9 1234",
      "k\\ill -9 1234",
      "xkill",
      "systemctl restart chromium",
      "systemctl --user restart chromium",
      "service chromium restart",
      "rm -rf ~/.browser-profiles/chromium",
      'rm -rf "$HOME/.browser-profiles/chromium"',
      "rm -f /tmp/.X1-lock",
      "bash -c 'pkill chromium'",
      'bash -lc "killall chrome"',
      "bash -o posix -c 'pkill chromium'",
      "bash --rcfile /tmp/bashrc -c 'pkill chromium'",
      "sh -c 'systemctl restart chromium'",
      `bash -c 'eval "pkill chromium"'`,
      'bash -lc "source /tmp/kill-chrome.sh"',
      "printf 'pkill chromium\\n' > /tmp/x; . /tmp/x",
      "bash -c `pkill chromium`",
      'bash <<< "pkill chromium"',
      "$KILLER chromium",
      'rm -rf "$TARGET/.browser-profiles/chromium"',
    ]) {
      expect(isProtectedComputerLifecycleCommand(command)).toBe(true);
    }
  });

  it("keeps ordinary shell work available", () => {
    expect(isProtectedComputerLifecycleCommand("pwd && ls -la")).toBe(false);
    expect(isProtectedComputerLifecycleCommand("node scripts/check.js")).toBe(false);
    expect(isProtectedComputerLifecycleCommand("systemctl status chromium")).toBe(false);
    expect(isProtectedComputerLifecycleCommand('rm -f "$WORKSPACE/tmp.txt"')).toBe(false);
    expect(isProtectedComputerLifecycleCommand("printf '%s\\n' *.txt && pwd")).toBe(false);
  });

  it.each([
    "find . -maxdepth 2 -type d -name .git -print",
    "git -C . status --short",
    "git add .",
    "git add then .",
    "ls . && git -C . worktree list --porcelain",
    "set -eu\npwd\nfind . -maxdepth 2 -type d -name .git -print",
    "git worktree add ../review-worktree origin/main",
    "find /tmp/. -maxdepth 1 -type d",
    "git diff -- .",
    "printf '%s' 'pk\\\nill chromium'",
    "printf '%s' 'pk\\\nill' chromium",
    "printf '%s' 'line one\nline two'",
  ])("allows repository paths without treating dot arguments as sourcing: %s", (command) => {
    expect(isProtectedComputerLifecycleCommand(command)).toBe(false);
  });

  it.each([
    ". /tmp/script.sh",
    "pwd; . /tmp/script.sh",
    "pwd\n. /tmp/script.sh",
    "find . -maxdepth 1 && . /tmp/script.sh",
    "command . /tmp/script.sh",
    "builtin . /tmp/script.sh",
    "command -p . /tmp/script.sh",
    "true && > /tmp/output . /tmp/script.sh",
    "2> /tmp/output . /tmp/script.sh",
    "if true; then . /tmp/script.sh; fi",
    "bash -c 'pwd\n. /tmp/script.sh'",
    "pk\\\nill chromium",
    "! . /tmp/script.sh",
    "if false; then :; elif . /tmp/script.sh; then :; fi",
    "{ . /tmp/script.sh; }",
    "coproc . /tmp/script.sh",
    "coproc worker . /tmp/script.sh",
    "function f { . /tmp/script.sh; }",
    "function f { . /tmp/script.sh; }; f",
  ])("continues blocking executable sourcing and lifecycle operations: %s", (command) => {
    expect(isProtectedComputerLifecycleCommand(command)).toBe(true);
  });

  it("names the trigger that the desktop-protection guard refused", () => {
    expect(protectedComputerLifecycleRefusal("pkill chromium")).toBe("protected command pkill");
    expect(protectedComputerLifecycleRefusal("kill -9 1234")).toBe("protected command kill");
    expect(protectedComputerLifecycleRefusal("systemctl restart chromium")).toBe(
      "systemctl restart",
    );
    expect(protectedComputerLifecycleRefusal("service chromium restart")).toBe("service restart");
    expect(protectedComputerLifecycleRefusal("rm -rf ~/.browser-profiles/chromium")).toBe(
      "browser profile path",
    );
    expect(protectedComputerLifecycleRefusal("rm -f /tmp/.X1-lock")).toBe("X11 path");
    expect(protectedComputerLifecycleRefusal('rm -rf "$TARGET/.browser-profiles/chromium"')).toBe(
      "unresolved variable $TARGET",
    );
    expect(protectedComputerLifecycleRefusal('for f in *.log; do wc -l "$f"; done')).toBe(
      "unresolved variable $f",
    );
    expect(protectedComputerLifecycleRefusal('echo "built at $(date)"')).toBe(
      "command substitution",
    );
    expect(protectedComputerLifecycleRefusal("echo `date`")).toBe("backtick");
    expect(protectedComputerLifecycleRefusal("( cd app && npm test )")).toBe("subshell");
    expect(protectedComputerLifecycleRefusal("python <<'EOF'\nprint(1)\nEOF")).toBe("heredoc");
    expect(protectedComputerLifecycleRefusal("source /tmp/kill-chrome.sh")).toBe("source");
    expect(protectedComputerLifecycleRefusal("eval 'ls'")).toBe("eval");
    expect(protectedComputerLifecycleRefusal('bash <<< "pkill chromium"')).toBe("herestring");
    expect(desktopProtectionGuardMessage("unresolved variable $f")).toBe(
      "This command was not run: desktop-protection guard: unresolved variable $f. Shell access is still available. Do not stop or restart browser or desktop processes.",
    );
  });

  it("allows comments, literal assignments, activate scripts, and quoted heredoc data", () => {
    for (const command of [
      "ls ~/workspace # check output",
      "echo foo # not a command\npwd",
      "echo foo#bar\npwd",
      'dir=/home/rakazo/workspace/app; ls "$dir"',
      'dir=/home/rakazo/workspace/app && ls "$dir"',
      "dir='/tmp/My Dir'; ls \"$dir\"",
      "source venv/bin/activate",
      "source venv/bin/activate && pytest",
      ". ./bin/activate",
      "command source venv/bin/activate",
      "cat > notes.md <<'EOF'\nhello\nEOF",
      "cat > notes.md <<'EOF'\nhello\n$(date)\nEOF\necho after",
      "cat > setup.sh <<'EOF'\nsource ./lib.sh\neval \"$REST\"\nEOF",
      'tee notes.md <<"EOF"\n# heading\nEOF',
      "cat <<'EOF' | tee notes.md\nhello\nEOF",
      "echo 'built at $(date)'",
      "ls # $(pkill chromium)",
      "bash -c 'source venv/bin/activate'",
      "source 'venv/bin/activate'",
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBeUndefined();
    }
  });

  it("offers a usable recovery for ordinary file updates refused as an interpreter heredoc", () => {
    const script = `import json, os
from pathlib import Path
state = Path("reports/state.json")
data = json.loads(state.read_text())
data["pending"] = False
temporary = state.with_suffix(".tmp")
temporary.write_text(json.dumps(data))
os.replace(temporary, state)
with Path("reports/history.jsonl").open("a") as log:
    log.write(json.dumps({"count": 3}) + "\\n")`;
    expect(protectedComputerLifecycleRefusal(`python <<'EOF'\n${script}\nEOF`)).toBe("heredoc");
    expect(desktopProtectionGuardMessage("heredoc")).toContain("python3 -c");
    expect(desktopProtectionGuardMessage("heredoc")).toContain(
      "does not indicate a filesystem permission error",
    );
    expect(protectedComputerLifecycleRefusal(`python3 -c '${script}'`)).toBeUndefined();
    expect(protectedComputerLifecycleRefusal(`python -c '${script}'`)).toBeUndefined();
    expect(protectedComputerLifecycleRefusal(`python3 -c '${script}'; pkill chromium`)).toBe(
      "protected command pkill",
    );
    expect(desktopProtectionGuardMessage("protected command pkill")).not.toContain("python3 -c");
  });

  it("allows Basic authentication syntax without weakening lifecycle protection", () => {
    const command = 'curl -H "Authorization: Basic $(printf test | base64)" https://example.test';
    expect(protectedComputerLifecycleRefusal(command)).toBe("command substitution");
    const script = `import base64, http.client, os
token = os.environ["EXAMPLE_API_TOKEN"]
authorization = "Basic " + base64.b64encode((token + ":token").encode()).decode()
connection = http.client.HTTPSConnection("example.test")
connection.request("GET", "/api", headers={"Authorization": authorization})
print(connection.getresponse().status)
connection.close()`;
    expect(protectedComputerLifecycleRefusal(`python3 -c '${script}'`)).toBeUndefined();
    expect(protectedComputerLifecycleRefusal(`python3 -c '${script}'; pkill chromium`)).toBe(
      "protected command pkill",
    );
  });

  it("keeps computed variables, variable source paths, and interpreter heredocs closed", () => {
    expect(protectedComputerLifecycleRefusal('dir=/tmp/$USER; ls "$dir"')).toBe(
      "unresolved variable $dir",
    );
    expect(protectedComputerLifecycleRefusal('dir=$(pwd); ls "$dir"')).toBe("command substitution");
    expect(protectedComputerLifecycleRefusal('dir=/tmp; other="$dir"; ls "$other"')).toBe(
      "unresolved variable $other",
    );
    expect(protectedComputerLifecycleRefusal('dir=/tmp ls "$dir"')).toBe(
      "unresolved variable $dir",
    );
    expect(
      protectedComputerLifecycleRefusal('dir=/tmp/.browser-profiles; rm -rf "$dir/chromium"'),
    ).toBe("browser profile path");
    expect(protectedComputerLifecycleRefusal('dir=venv/bin/activate; source "$dir"')).toBe(
      "source",
    );
    expect(protectedComputerLifecycleRefusal('source "$VENV/bin/activate"')).toBe("source");
    expect(protectedComputerLifecycleRefusal("source venv/bin/activate.fish")).toBe("source");
    expect(protectedComputerLifecycleRefusal("bash <<'EOF'\npwd\nEOF")).toBe("heredoc");
    expect(protectedComputerLifecycleRefusal("sh <<'EOF'\npwd\nEOF")).toBe("heredoc");
    expect(protectedComputerLifecycleRefusal("cat <<'EOF' | bash\npwd\nEOF")).toBe("heredoc");
    expect(protectedComputerLifecycleRefusal("cat <<'EOF' | python3\nprint(1)\nEOF")).toBe(
      "heredoc",
    );
    expect(protectedComputerLifecycleRefusal("node <<'EOF'\nconsole.log(1)\nEOF")).toBe("heredoc");
    expect(protectedComputerLifecycleRefusal("cat <<EOF\n$(pkill chromium)\nEOF")).toBe(
      "command substitution",
    );
    expect(protectedComputerLifecycleRefusal("echo ok # comment\npkill chromium")).toBe(
      "protected command pkill",
    );
    expect(protectedComputerLifecycleRefusal("echo foo#bar\npkill chromium")).toBe(
      "protected command pkill",
    );
    expect(protectedComputerLifecycleRefusal("dir=pkill; $dir chromium")).toBe(
      "protected command pkill",
    );
    expect(protectedComputerLifecycleRefusal("dir='pkill chromium'; $dir")).toBe(
      "protected command pkill",
    );
    expect(protectedComputerLifecycleRefusal("dir='pkill chromium'; bash -c \"$dir\"")).toBe(
      "protected command pkill",
    );
    expect(protectedComputerLifecycleRefusal("dir='rm -rf ~/.browser-profiles'; $dir")).toBe(
      "browser profile path",
    );
    expect(protectedComputerLifecycleRefusal("ls # $(pkill)\npkill chromium")).toBe(
      "protected command pkill",
    );
    expect(protectedComputerLifecycleRefusal("bash -c 'source /tmp/x'")).toBe("source");
    expect(protectedComputerLifecycleRefusal('dir=/tmp/app; declare other=1; ls "$dir"')).toBe(
      undefined,
    );
    expect(
      protectedComputerLifecycleRefusal('dir=/tmp/app; printf -v count %s hi; echo "$dir"'),
    ).toBe(undefined);
  });

  it("drops a tracked literal when a later command can assign that name", () => {
    for (const command of [
      "dir=x; declare dir=pkill; $dir chromium",
      "dir=x; local dir=pkill; $dir chromium",
      "dir=x; typeset dir=pkill; $dir chromium",
      "dir=x; readonly dir=pkill; $dir chromium",
      "dir=x; read dir < /tmp/cmd; $dir chromium",
      "dir=x; printf -v dir '%s' 'pkill chromium'; $dir",
      "dir=x; mapfile -t dir < /tmp/cmd; $dir chromium",
      "dir=x; readarray -t dir < /tmp/cmd; $dir chromium",
      "dir=x; getopts ab dir; $dir chromium",
      "dir=x; for dir in 'pkill chromium'; do $dir; done",
      "dir=x; source venv/bin/activate; $dir chromium",
      "dir=x; . ./bin/activate; $dir chromium",
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBe("unresolved variable $dir");
    }
  });

  it("clears every tracked literal when a nameref can retarget one", () => {
    for (const command of [
      "dir=echo; declare -n alias=dir; alias=pkill; $dir chromium",
      "dir=echo; typeset -n alias=dir; alias=pkill; $dir chromium",
      "dir=echo; local -n alias=dir; alias=pkill; $dir chromium",
      "dir=echo; readonly -n alias=dir; alias=pkill; $dir chromium",
      "dir=echo; declare -xn alias=dir; alias=pkill; $dir chromium",
      'dir=/tmp/app; declare -n alias=other; echo "$dir"',
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBe("unresolved variable $dir");
    }
    expect(
      protectedComputerLifecycleRefusal('dir=/tmp/app; declare -p; echo "$dir"'),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal('dir=/tmp/app; declare -- -n; echo "$dir"'),
    ).toBeUndefined();
  });

  it("does not substitute expansions after IFS changes", () => {
    expect(protectedComputerLifecycleRefusal("IFS=X; dir=pkillXchromium; $dir")).toBe(
      "unresolved variable $dir",
    );
    expect(protectedComputerLifecycleRefusal('dir=/tmp/app; IFS=X; echo "$dir"')).toBe(
      "unresolved variable $dir",
    );
    expect(protectedComputerLifecycleRefusal("dir=pkillXchromium IFS=X; $dir")).toBe(
      "unresolved variable $dir",
    );
  });

  it("refuses writes that can plant a sourced activate script", () => {
    for (const command of [
      "printf '%s\\n' 'pkill chromium' > venv/bin/activate",
      "printf '%s\\n' 'pkill chromium' > 'venv/bin/activate'",
      "printf '%s\\n' 'pkill chromium' > venv/bin/activate; source venv/bin/activate",
      "echo hi >> ./bin/activate",
      "echo hi &> /tmp/v/bin/activate",
      "echo hi > /tmp/v/bin/activate && source /tmp/v/bin/activate",
      'dest=venv/bin/activate; printf x > "$dest"',
      "tee venv/bin/activate",
      "cp /tmp/evil venv/bin/activate",
      "mv /tmp/evil venv/bin/activate",
      "install /tmp/evil venv/bin/activate",
      "dd of=venv/bin/activate",
      "echo hi > venv/bin/./activate",
      "echo hi > venv/bin/foo/../activate",
      "echo hi > venv/bin//activate",
      "cp -t venv/bin /tmp/activate",
      "cp -tvenv/bin /tmp/activate",
      "cp --target-directory venv/bin /tmp/activate",
      "cp --target-directory=venv/bin /tmp/activate",
      "cp -t venv/bin/./ /tmp/activate",
      "mv -t venv/bin /tmp/activate",
      "mv --target-directory=venv/bin /tmp/activate",
      "ln -t venv/bin /tmp/activate",
      "install -t venv/bin /tmp/activate",
      "install --target-directory=venv/bin /tmp/activate",
      "install -m 755 -t venv/bin /tmp/activate",
      "cp /tmp/evil venv/bin/./activate",
      "dd of=venv/bin/foo/../activate",
      "mv /tmp/x/bin venv/bin",
      "ln -s /tmp/x/bin venv/bin",
      "cp -r /tmp/x/bin venv/bin",
      "cp -a /tmp/x/bin venv/",
      "mv -t venv /tmp/x/bin",
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBe("activate script");
    }
    expect(protectedComputerLifecycleRefusal("echo hi > notes.md; source venv/bin/activate")).toBe(
      undefined,
    );
    expect(protectedComputerLifecycleRefusal("cp venv/bin/activate /tmp/backup")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("cp -t /backup venv/bin/activate")).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("mv --target-directory=/backup venv/bin/activate"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("install -t /backup venv/bin/activate"),
    ).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("ln -t /backup venv/bin/activate")).toBeUndefined();
    for (const command of [
      "ln -sfn /tmp/x/bin venv/bin",
      "ln -s -t venv /tmp/x/bin",
      "cp -a /tmp/x/bin venv/bin",
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBe("activate script");
    }
    expect(protectedComputerLifecycleRefusal("mv /tmp/notes.txt /tmp/bin")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("mv /tmp/notes.txt venv/bin")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("mv /tmp/x/bin /tmp/backup")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("ln -s /tmp/x/bin /tmp/backup")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("mv /tmp/notes.txt /tmp/bin")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("mv /tmp/notes.txt venv/bin")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("ln -s /tmp/notes.txt /tmp/bin")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("cp -r /tmp/notes.txt /tmp/bin")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("echo notes > ../notes.txt")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("echo notes > ../docs/notes.txt")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("echo notes > ../bin/activate")).toBe(
      "activate script",
    );
    expect(protectedComputerLifecycleRefusal('dest=notes.md; printf x > "$dest"')).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("source venv/bin/activate")).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("source venv/bin/./activate")).toBe("source");
    expect(protectedActivateScriptWriteRefusal("venv/bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("./bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("/tmp/v/bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("venv/bin/./activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("venv/bin/foo/../activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("//tmp//v/bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("../venv/bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("../bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("foo/../../bin/activate")).toBe("activate script");
    expect(protectedActivateScriptWriteRefusal("../notes.txt")).toBeUndefined();
    expect(protectedActivateScriptWriteRefusal("../docs/notes.txt")).toBeUndefined();
    expect(protectedActivateScriptWriteRefusal("notes.md")).toBeUndefined();
    expect(protectedActivateScriptWriteRefusal("venv/bin/activate.fish")).toBeUndefined();
  });

  it("refuses a quoted heredoc whose body names a desktop lifecycle command", () => {
    expect(protectedComputerLifecycleRefusal("cat > x <<'EOF'\npkill chromium\nEOF")).toBe(
      "heredoc",
    );
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nsystemctl restart chromium\nEOF"),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal(
        "cat > notes.md <<'EOF'\nrm -rf ~/.browser-profiles/chromium\nEOF",
      ),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nrm -f /tmp/.X1-lock\nEOF"),
    ).toBe("heredoc");
  });

  it("refuses a quoted heredoc that hides a lifecycle command in split quotes", () => {
    for (const body of [
      "pk''ill chromium",
      "'pk''ill' chromium",
      '"pk""ill" chromium',
      "p'k'ill chromium",
      "sys''temctl re''start chromium",
      "rm -rf ~/.browser-''profiles/chromium",
      "pk'ill chromium",
      "pk$ill chromium",
    ]) {
      expect(protectedComputerLifecycleRefusal(`cat > /tmp/x.sh <<'EOF'\n${body}\nEOF`), body).toBe(
        "heredoc",
      );
    }
  });

  it("refuses a quoted heredoc that splices a lifecycle command", () => {
    for (const body of [
      "p$(printf k)ill chromium",
      "p$(printf 'k')ill chromium",
      'p"$(printf k)"ill chromium',
      "pk$(printf ill) chromium",
      "$(printf pk)ill chromium",
      "sys$(printf tem)ctl restart chromium",
      "p$(date)ill chromium",
      `p$(printf k)ill chromium\n\${x:-y}`,
      "$(printf p)$(printf k)$(printf i)$(printf l)$(printf l) chromium",
      "$(printf s)$(printf y)$(printf s)$(printf t)$(printf e)$(printf m)$(printf c)$(printf t)$(printf l) restart chromium",
      "rm -f $(printf /)$(printf t)$(printf m)$(printf p)$(printf /)$(printf .)$(printf x)$(printf 1)-lock",
    ]) {
      expect(protectedComputerLifecycleRefusal(`cat > /tmp/x.sh <<'EOF'\n${body}\nEOF`), body).toBe(
        "heredoc",
      );
    }
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\necho $(date)\nEOF"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nfile-$(date).txt\nEOF"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\n{\"ok\":true}\nEOF"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nsys$(date)ctl status\nEOF"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cat > notes.md <<'EOF'\necho \"$(date)-$(whoami)-$(hostname)-$(pwd)-$(id)-$(uname)\"\nEOF",
      ),
    ).toBeUndefined();
  });

  it("allows quoted heredoc prose that does not name a lifecycle command", () => {
    for (const body of [
      "Don't restart the server",
      "# Don't restart the server",
      "$VAR",
      '"Value: $VAR"',
      "See `notes` for details",
      "echo `date`",
      "echo $((1))",
    ]) {
      expect(
        protectedComputerLifecycleRefusal(`cat > notes.md <<'EOF'\n${body}\nEOF`),
        body,
      ).toBeUndefined();
    }
    expect(
      protectedComputerLifecycleRefusal(
        "cat > notes.md <<'EOF'\nDon't restart the server\nEOF\necho after",
      ),
    ).toBeUndefined();
  });

  it("refuses a relative run of a heredoc-written path after cd", () => {
    expect(
      protectedComputerLifecycleRefusal(
        "cat > sub/x.sh <<'EOF'\nhello\nEOF\ncd sub\nchmod +x x.sh\n./x.sh",
      ),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal("cat > sub/x.sh <<'EOF'\nhello\nEOF\ncd sub\n./x.sh"),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal("cat > sub/x.sh <<'EOF'\nhello\nEOF\n./sub/x.sh"),
    ).toBe("heredoc");
    expect(protectedComputerLifecycleRefusal('cat > sub/x.sh <<\'EOF\'\n"$cmd"\nEOF\n"$cmd"')).toBe(
      "heredoc",
    );
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nhello\nEOF\ncd /tmp"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > sub/x.sh <<'EOF'\nhello\nEOF\ncd sub"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nhello\nEOF\n/usr/bin/git status"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\n\"$cmd\"\nEOF\necho after"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cd sub\ncat > x.sh <<'EOF'\nhello\nEOF\n./x.sh"),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal(
        "cd sub; cat > x.sh <<'EOF'\nhello\nEOF\ncd ..; cd sub; ./x.sh",
      ),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal("cd sub; cat > x.sh <<'EOF'\nhello\nEOF\ncd ..; ./x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cd sub; cat > x.sh <<'EOF'\nhello\nEOF\n"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cd sub; cat > notes.md <<'EOF'\nhello\nEOF\n/usr/bin/git status",
      ),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nhello\nEOF\ncd -\necho after"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cat > notes.md <<'EOF'\nhello\nEOF\ncd -\n/usr/bin/git status",
      ),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > sub/x.sh <<'EOF'\nhello\nEOF\ncd -\n./x.sh"),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal(
        "cat > sub/x.sh <<'EOF'\nhello\nEOF\ncd -\n/opt/tools/x.sh",
      ),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cat > /opt/tools/x.sh <<'EOF'\nhello\nEOF\ncd -\n/opt/tools/x.sh",
      ),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\ncd sub | cat\n./x.sh"),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\ncd sub &\n./x.sh"),
    ).toBe("heredoc");
  });

  it("allows an unrelated absolute path with the same basename as a relative heredoc write", () => {
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\n/opt/tools/x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\nchmod +x /opt/tools/x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\ncd /tmp\n/opt/tools/x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\ncd -\n/opt/tools/x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cat > x.sh <<'EOF'\nhello\nEOF\ncd /tmp\nchmod +x /opt/tools/x.sh",
      ),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cat > sub/x.sh <<'EOF'\nhello\nEOF\ncd /tmp\n/work/sub/x.sh",
      ),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > x.sh <<'EOF'\nhello\nEOF\ncd -\n/work/x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal(
        "cd /work\ncat > x.sh <<'EOF'\nhello\nEOF\ncd /tmp\n/work/x.sh",
      ),
    ).toBe("heredoc");
    expect(
      protectedComputerLifecycleRefusal(
        "cd /work\ncat > x.sh <<'EOF'\nhello\nEOF\ncd /tmp\nchmod +x /work/x.sh",
      ),
    ).toBe("heredoc");
  });

  it("refuses running a path a quoted heredoc just wrote", () => {
    for (const command of [
      "cat > /tmp/x.sh <<'EOF'\nhello\nEOF\nchmod +x /tmp/x.sh\n/tmp/x.sh",
      "cat > /tmp/x.sh <<'EOF'\nhello\nEOF\n/tmp/x.sh",
      "cat > /tmp/x.sh <<'EOF'\nhello\nEOF\nchmod +x /tmp/x.sh",
      "tee /tmp/x.sh <<'EOF'\nhello\nEOF\n/tmp/x.sh",
      "cat <<'EOF' | tee /tmp/x.sh\nhello\nEOF\n/tmp/x.sh",
      "cat > ./x.sh <<'EOF'\nhello\nEOF\n./x.sh",
      "cat <<'EOF' | tee > /tmp/x.sh\nhello\nEOF\n/tmp/x.sh",
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBe("heredoc");
    }
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nhello\nEOF\necho after"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > notes.md <<'EOF'\nhello\nEOF\nchmod +x /tmp/other"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat > /tmp/x.sh <<'EOF'\nhello\nEOF\nls /tmp/x.sh"),
    ).toBeUndefined();
    expect(
      protectedComputerLifecycleRefusal("cat <<'EOF' |\necho data\nEOF\necho done"),
    ).toBeUndefined();
    expect(protectedComputerLifecycleRefusal("cat <<'EOF' |\npwd\nEOF\nbash")).toBe("heredoc");
  });

  it("refuses heredoc writes that a later command can execute", () => {
    for (const command of [
      "cat > /tmp/x.sh <<'EOF'\npkill chromium\nEOF\nbash /tmp/x.sh",
      "tee /tmp/x.sh <<'EOF'\npkill chromium\nEOF\nsh /tmp/x.sh",
      "cat <<'EOF' | tee /tmp/x.sh\npkill chromium\nEOF\nbash /tmp/x.sh",
      "cat > notes.md <<'EOF'\nhello\nEOF\nbash /tmp/x.sh",
      "cat > /tmp/v/bin/activate <<'EOF'\npkill chromium\nEOF\nsource /tmp/v/bin/activate",
      "cat > /tmp/v/bin/activate <<'EOF'\npkill chromium\nEOF\n. /tmp/v/bin/activate",
      "cat > notes.md <<'EOF'\nhello\nEOF\nsource venv/bin/activate",
      "cat > /tmp/x.sh <<'EOF'\npkill chromium\nEOF\nsudo bash /tmp/x.sh",
      "cat > /tmp/x.sh <<'EOF'\npkill chromium\nEOF\nbusybox sh /tmp/x.sh",
      "cat <<'EOF' | xargs -I{} bash -c {}\npkill chromium\nEOF",
      "cat <<'EOF' | awk 'system(\"pkill chromium\")'\nEOF",
      "cat <<'EOF' | sed 's/a/b/'\nhello\nEOF",
      "cat <<'EOF' | busybox sh\npkill chromium\nEOF",
    ]) {
      expect(protectedComputerLifecycleRefusal(command), command).toBe("heredoc");
    }
  });
});

it("guards by the computer a run actually uses", () => {
  const stored = { kind: "docker" };
  expect(desktopGuardApplies({ graphical: true, stored })).toBe(true);
  // Not started yet: it may still reuse the running Linux computer.
  expect(desktopGuardApplies({ graphical: true, stored, kind: "wuying" })).toBe(true);
  expect(
    desktopGuardApplies({
      graphical: true,
      stored,
      kind: "wuying",
      lazy: { ready: { kind: "wuying" } },
    }),
  ).toBe(false);
  expect(
    desktopGuardApplies({
      graphical: true,
      stored,
      kind: "wuying",
      lazy: { ready: { kind: "docker" } },
    }),
  ).toBe(true);
  expect(desktopGuardApplies({ graphical: true, stored: { kind: "wuying" } })).toBe(false);
});
