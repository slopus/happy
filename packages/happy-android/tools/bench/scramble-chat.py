#!/usr/bin/env python3
"""Scrambles a recorded conversation for ChatListBenchmark's committed fixture.

    scramble-chat.py recording.json out.json.gz

The input is one or more `GET /v0/agents/:id/messages?omitToolData=true` pages
merged into `{"runs": [...]}`, oldest first. The output keeps everything that
decides layout and nothing that was said: every letter becomes a random letter
of the same case and every digit a random digit, while spaces, line breaks,
punctuation and markdown markers stay, so each text keeps its length, its
lines, its words' lengths, its lists, tables, headers and code fences. Block
types, roles, statuses, tool names, presentation types, media kinds, sizes and
times are kept. IDs map to fresh IDs of the same length, the same everywhere.
Thumbhashes are dropped (a picture keeps its stated size).
"""
import gzip
import json
import random
import re
import string
import sys

KEEP = {"type", "role", "status", "name", "kind", "mimeType", "reason", "providerId", "modelId", "effort", "permissionMode", "serviceTier"}
ID_KEYS = {"id", "runId", "agentId", "senderAgentId", "artifactId", "parentAgentId"}
ID = re.compile(r"^[a-z0-9]{20,32}$")
rng = random.Random(7)
ids = {}


def new_id(value):
    if value not in ids:
        ids[value] = "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in value)
    return ids[value]


def scramble(text):
    out = []
    for c in text:
        if "a" <= c <= "z" or c.isalpha() and c.islower():
            out.append(rng.choice(string.ascii_lowercase))
        elif "A" <= c <= "Z" or c.isalpha():
            out.append(rng.choice(string.ascii_uppercase))
        elif c.isdigit():
            out.append(rng.choice(string.digits))
        else:
            out.append(c)
    return "".join(out)


def walk(value, key=None):
    if isinstance(value, dict):
        # A media item's name is a file name, said by someone; a tool call's is the tool.
        media = "kind" in value
        return {k: (scramble(v) if media and k == "name" and isinstance(v, str) else walk(v, k)) for k, v in value.items() if k != "thumbhash"}
    if isinstance(value, list):
        return [walk(v, key) for v in value]
    if isinstance(value, str):
        if key in ID_KEYS or ID.match(value):
            return new_id(value)
        if key in KEEP:
            return value
        return scramble(value)
    return value


def main():
    source, target = sys.argv[1], sys.argv[2]
    data = json.load(open(source))
    runs = walk(data["runs"])
    with gzip.open(target, "wt", encoding="utf-8") as f:
        json.dump({"runs": runs}, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
