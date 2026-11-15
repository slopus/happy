#!/usr/bin/env bash
# Bind-mounted homes use the host's numeric identity. Desktop services also
# need it in passwd/group, without modifying the image or running root.
uid=$(id -u) || exit 1
gid=$(id -g) || exit 1
(
  umask 077
  mkdir -p "$(dirname "$NSS_WRAPPER_PASSWD")" || exit 1
  cp /etc/passwd "$NSS_WRAPPER_PASSWD" || exit 1
  cp /etc/group "$NSS_WRAPPER_GROUP" || exit 1
  if ! awk -F: -v uid="$uid" '$3 == uid { found = 1 } END { exit !found }' /etc/passwd; then
    printf 'rakazo-runtime:x:%s:%s:Computer:/home/rakazo:/bin/bash\n' "$uid" "$gid" >> "$NSS_WRAPPER_PASSWD" || exit 1
  fi
  if ! awk -F: -v gid="$gid" '$3 == gid { found = 1 } END { exit !found }' /etc/group; then
    printf 'rakazo-runtime:x:%s:\n' "$gid" >> "$NSS_WRAPPER_GROUP" || exit 1
  fi
) || {
  echo "Failed to create nss_wrapper passwd/group files" >&2
  exit 1
}
export LD_PRELOAD=/usr/local/lib/libnss_wrapper.so
