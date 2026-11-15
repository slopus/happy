"""ZIP ingestion for the trusted Playwright publisher."""

import shutil
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath


def extract(archive_path: str, destination: str) -> None:
    """Validate every entry, then extract regular files into a new data directory."""
    root = Path(destination)
    with zipfile.ZipFile(archive_path) as archive:
        # Validate the entire archive before writing any entry. GitHub uploads do
        # not need links, absolute paths, or parent-directory components.
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (
                name.is_absolute()
                or ".." in name.parts
                or "\\" in entry.filename
                or not name.parts
                or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
            ):
                raise ValueError("Unsafe Playwright artifact entry")

        # A fresh directory also prevents following pre-existing filesystem links.
        root.mkdir(parents=True, exist_ok=False)
        for entry in archive.infolist():
            target = root / entry.filename
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: extract-playwright-artifacts <archive> <destination>")
    extract(sys.argv[1], sys.argv[2])
