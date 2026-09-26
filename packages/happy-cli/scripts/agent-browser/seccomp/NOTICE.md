# Vendored seccomp base

`moby-default.json` is Docker's default seccomp profile, copied unmodified from
[moby/profiles](https://github.com/moby/profiles) tag `seccomp/v0.2.3`
(commit `836ae4d37ef2ec995c77c99fc55f5b5f3af3a897`, file `seccomp/default.json`,
SHA-256 `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`),
licensed under the Apache License 2.0.

`abp-install` derives `/etc/abp/seccomp-chromium.json` from it with
`chromiumSeccompProfile` (`lib/abpPlan.mjs`): the default rules unchanged plus one
rule allowing `chroot`, `clone`, `setns` and `unshare`, which Chromium's own
namespace sandbox needs and which the default profile allows only to containers
holding CAP_SYS_ADMIN. To update, replace the file with a newer tagged release,
record the tag, commit and hash here, and rerun the unit tests.
