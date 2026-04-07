#!/usr/bin/env python3
"""Voice agent usage — admin report for the past 7 days.

For per-user usage, check the voice settings screen in the mobile app
or call GET /v1/voice/usage with an auth token.
"""

import json
import os
import time
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import datetime

API_KEY = os.environ.get("ELEVENLABS_ANALYTICS_KEY", "")
if not API_KEY:
    print("Set ELEVENLABS_ANALYTICS_KEY env var")
    raise SystemExit(1)
BASE = "https://api.elevenlabs.io/v1/convai/conversations"
WEEK_AGO = int(time.time()) - 7 * 86400
FREE_LIMIT = 3600
HARD_LIMIT = 18000


def api_get(url, retries=3):
    req = urllib.request.Request(url, headers={
        "xi-api-key": API_KEY,
        "Accept": "application/json",
    })
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                wait = 2 ** (attempt + 1)
                print(f"  rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            raise


def fmt_time(secs):
    if secs >= 3600:
        return f"{secs // 3600}h {(secs % 3600) // 60}m {secs % 60}s"
    return f"{secs // 60}m {secs % 60}s"


def fmt_date(unix_ts):
    return datetime.fromtimestamp(unix_ts).strftime("%Y-%m-%d %H:%M")


def fetch_all_convos():
    """Paginate through all conversations from the past week."""
    print("Fetching conversation list...")
    all_convos = []
    cursor = None
    pages = 0
    while True:
        url = f"{BASE}?page_size=100"
        if cursor:
            url += f"&cursor={cursor}"
        data = api_get(url)
        hit_cutoff = False
        for c in data.get("conversations", []):
            if c["start_time_unix_secs"] >= WEEK_AGO:
                all_convos.append(c)
            else:
                hit_cutoff = True
                break
        pages += 1
        if pages % 10 == 0:
            print(f"  page {pages}, {len(all_convos)} conversations...")
        if hit_cutoff:
            break
        if data.get("has_more") and data.get("next_cursor"):
            cursor = data["next_cursor"]
        else:
            break
    print(f"Found {len(all_convos)} conversations in the past 7 days\n")
    return all_convos


def get_known_user_ids(all_convos):
    """
    Fetch detail for a small sample to discover unique user_ids,
    then query per-user to get complete data. Much faster than
    fetching detail for every conversation.
    """
    # Sample recent conversations to discover user_ids
    print("Sampling conversations to discover users...")
    seen_users = set()
    sample_size = min(50, len(all_convos))
    for i, c in enumerate(all_convos[:sample_size]):
        cid = c["conversation_id"]
        try:
            detail = api_get(f"{BASE}/{cid}")
            uid = detail.get("user_id")
            auth = detail.get("metadata", {}).get("authorization_method")
            if uid:
                seen_users.add(uid)
            # Store on the conversation
            c["_user_id"] = uid or ""
            c["_auth_method"] = auth
        except Exception:
            c["_user_id"] = ""
            c["_auth_method"] = "unknown"
        if (i + 1) % 10 == 0:
            time.sleep(0.5)  # pace ourselves

    print(f"  found {len(seen_users)} unique user IDs from sample\n")
    return seen_users


def get_user_convos(user_id):
    """Fetch all conversations for a specific user_id (paginated)."""
    convos = []
    cursor = None
    while True:
        url = f"{BASE}?page_size=100&user_id={user_id}"
        if cursor:
            url += f"&cursor={cursor}"
        data = api_get(url)
        for c in data.get("conversations", []):
            if c["start_time_unix_secs"] >= WEEK_AGO:
                convos.append(c)
            else:
                return convos  # ordered desc, we're past the cutoff
        if data.get("has_more") and data.get("next_cursor"):
            cursor = data["next_cursor"]
        else:
            break
    return convos


def full_report():
    all_convos = fetch_all_convos()
    if not all_convos:
        print("No conversations found.")
        return

    total_calls = len(all_convos)
    total_secs = sum(c.get("call_duration_secs", 0) for c in all_convos)

    # Agent breakdown
    agents = defaultdict(lambda: {"count": 0, "secs": 0, "name": ""})
    for c in all_convos:
        aid = c.get("agent_id", "unknown")
        agents[aid]["count"] += 1
        agents[aid]["secs"] += c.get("call_duration_secs", 0)
        agents[aid]["name"] = c.get("agent_name", "")

    # Discover users from sample
    user_ids = get_known_user_ids(all_convos)

    # Fetch per-user data
    print("Fetching per-user conversation history...")
    user_data = {}
    for uid in user_ids:
        time.sleep(0.3)  # pace
        convos = get_user_convos(uid)
        total = sum(c.get("call_duration_secs", 0) for c in convos)
        user_data[uid] = {"count": len(convos), "secs": total, "convos": convos}
        print(f"  {uid[:50]}: {len(convos)} calls, {fmt_time(total)}")

    # Calculate unattributed
    attributed_calls = sum(u["count"] for u in user_data.values())
    attributed_secs = sum(u["secs"] for u in user_data.values())
    unattributed_calls = total_calls - attributed_calls
    unattributed_secs = total_secs - attributed_secs

    # ── Report ──
    print(f"\n{'=' * 72}")
    print(f"  VOICE AGENT USAGE — PAST 7 DAYS")
    print(f"{'=' * 72}")

    print(f"\nOVERVIEW")
    print(f"  Total conversations:    {total_calls}")
    print(f"  Total voice time:       {fmt_time(total_secs)}")
    print(f"  Identified users:       {len(user_ids)}")
    print(f"  Attributed calls:       {attributed_calls} ({100 * attributed_calls / total_calls:.1f}%)")
    print(f"  Unattributed calls:     {unattributed_calls} ({100 * unattributed_calls / total_calls:.1f}%)")

    # Agent breakdown
    print(f"\nAGENT BREAKDOWN")
    for aid, info in sorted(agents.items(), key=lambda x: -x[1]["count"]):
        print(f"  {aid}  {info['name']}")
        print(f"    {info['count']} calls, {fmt_time(info['secs'])}")

    # Per-user breakdown
    ranked = sorted(user_data.items(), key=lambda x: -x[1]["secs"])
    print(f"\nPER-USER BREAKDOWN (ranked by total time)")
    print(f"  {'#':<4} {'User ID':<52} {'Calls':>6} {'Time':>12} {'Limit Status'}")
    print(f"  {'-' * 95}")
    for i, (uid, info) in enumerate(ranked, 1):
        if info["secs"] >= HARD_LIMIT:
            status = f"BLOCKED (>{fmt_time(HARD_LIMIT)} hard cap)"
        elif info["secs"] >= FREE_LIMIT:
            status = f"PAYWALLED (>{fmt_time(FREE_LIMIT)} free)"
        else:
            remaining = FREE_LIMIT - info["secs"]
            status = f"{fmt_time(remaining)} free remaining"
        label = uid[:50] if len(uid) > 50 else uid
        print(f"  {i:<4} {label:<52} {info['count']:>6} {fmt_time(info['secs']):>12} {status}")

    if unattributed_calls > 0:
        print(f"  {'—':<4} {'(unattributed / no user_id)':<52} {unattributed_calls:>6} {fmt_time(unattributed_secs):>12} {'NO RATE LIMIT'}")

    # Daily distribution
    day_buckets = defaultdict(lambda: {"count": 0, "secs": 0})
    for c in all_convos:
        day = datetime.fromtimestamp(c["start_time_unix_secs"]).strftime("%Y-%m-%d")
        day_buckets[day]["count"] += 1
        day_buckets[day]["secs"] += c.get("call_duration_secs", 0)

    print(f"\nDAILY DISTRIBUTION")
    print(f"  {'Date':<14} {'Calls':>7} {'Time':>12} {'Avg/call':>10}")
    print(f"  {'-' * 45}")
    for day in sorted(day_buckets.keys()):
        b = day_buckets[day]
        avg = b["secs"] // b["count"] if b["count"] else 0
        print(f"  {day:<14} {b['count']:>7} {fmt_time(b['secs']):>12} {avg:>8}s")

    # Duration distribution
    print(f"\nCALL DURATION DISTRIBUTION")
    brackets = [(0, 10), (10, 30), (30, 60), (60, 120), (120, 300), (300, 600), (600, float("inf"))]
    labels = ["0-10s", "10-30s", "30s-1m", "1-2m", "2-5m", "5-10m", "10m+"]
    for (lo, hi), label in zip(brackets, labels):
        matching = [c for c in all_convos if lo <= c.get("call_duration_secs", 0) < hi]
        total_dur = sum(c.get("call_duration_secs", 0) for c in matching)
        bar = "█" * (len(matching) // 20)
        print(f"  {label:<10} {len(matching):>6} calls  {fmt_time(total_dur):>12}  {bar}")

    # Termination reasons
    term_reasons = defaultdict(int)
    for c in all_convos:
        term_reasons[c.get("termination_reason", "unknown")] += 1
    print(f"\nTERMINATION REASONS")
    for reason, count in sorted(term_reasons.items(), key=lambda x: -x[1])[:10]:
        print(f"  {count:>6}  {reason}")

    # Account quota
    print(f"\nACCOUNT QUOTA")
    try:
        sub = api_get("https://api.elevenlabs.io/v1/user/subscription")
        used = sub.get("character_count", 0)
        limit = sub.get("character_limit", 0)
        pct = 100 * used / limit if limit else 0
        reset = sub.get("next_character_count_reset_unix", 0)
        days_left = (reset - int(time.time())) / 86400 if reset else 0
        print(f"  Tier:           {sub.get('tier', '?')}")
        print(f"  Characters:     {used:,} / {limit:,} ({pct:.1f}%)")
        print(f"  Remaining:      {limit - used:,}")
        print(f"  Resets:         {datetime.fromtimestamp(reset).strftime('%Y-%m-%d') if reset else '?'} ({days_left:.0f} days)")
    except Exception as e:
        print(f"  Failed to fetch: {e}")

    print(f"\n{'=' * 72}")


if __name__ == "__main__":
    full_report()
