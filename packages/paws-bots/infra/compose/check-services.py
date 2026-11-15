#!/usr/bin/env python3
"""Read-only service checks, independent of the application's logging pipeline."""
import subprocess
import sys


def service_failures(rows, expected=("api", "worker"), optional=("pitr",)):
    failures = []
    for service in (*expected, *optional):
        states = [row for row in rows if row["service"] == service]
        if not states:
            if service in expected:
                failures.append(f"{service} container is missing")
        elif not any(row["state"] == "running" and row["health"] in ("healthy", "") for row in states):
            # During rolling replacement one healthy replica is sufficient.
            failures.append(f"{service} has no healthy running container")
    return failures


def main(project):
    result = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}",
         "--format", '{{.Label "com.docker.compose.service"}}|{{.State}}|{{.Status}}'],
        capture_output=True, text=True, timeout=15, check=True,
    )
    rows = []
    for line in result.stdout.splitlines():
        service, state, status = line.split("|", 2)
        if "unhealthy" in status:
            health = "unhealthy"
        elif "health: starting" in status:
            health = "starting"
        elif "(healthy)" in status:
            health = "healthy"
        else:
            health = ""
        rows.append({"service": service, "state": state, "health": health})
    failures = service_failures(rows)
    for failure in failures:
        print(failure)
    return bool(failures)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1]))
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        print("Could not inspect application container health")
        sys.exit(1)
