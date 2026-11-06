#!/usr/bin/env python3
"""Stamp the application version and the single-instance identity into the reviewed tree.

The reviewed source tree used by .github/workflows/preview10-natural-understanding.yml is
built from a published baseline archive plus a chain of reviewed overlays. Every overlay
verifies exact before/after checksums of the files it touches, therefore the version can
only be stamped AFTER the last overlay has been applied and BEFORE the frontend/native
build.

The tool is deliberately strict:

* every rule must actually change the tree (or be explicitly idempotent / optional), so a
  silently skipped rule can never produce an artifact with a stale version again;
* after stamping, the previous version literal must be gone from every managed file;
* an audit pass reports any remaining occurrence anywhere in the source tree.

No publication, no signing, no network access.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import fnmatch
from pathlib import Path, PurePosixPath

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")

# Packages whose Cargo.toml/Cargo.lock/SBOM entries belong to this project.
OWN_CRATES = (
    "kf-domain",
    "kf-engine",
    "kf-ipc",
    "kf-moonraker",
    "kf-storage",
    "kf-update",
    "klipper-farm-client",
)

SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "rv",
    "target",
    ".klipper-build-cache",
    "INSTALLER",
    ".update-components",
    ".tauri",
}

AUDIT_SUFFIXES = (
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".rs",
    ".toml",
    ".json",
    ".py",
    ".ps1",
    ".bat",
    ".cmd",
    ".html",
    ".css",
)

# Files whose every occurrence of the version literal is a managed occurrence.
LITERAL_ALL = (
    "src/components/SystemPanel.tsx",
    "src/components/SetupWizard.tsx",
    "src/components/LoginPanel.tsx",
)

OPTIONAL_LITERAL_ALL = ("FIX_AND_INSTALL.bat",)

# Reviewed occurrences of the previous version literal that must NOT be stamped.
# Every entry is a glob over the POSIX path inside the application tree plus the
# reason it is allowed to keep the old literal; anything not listed here fails
# --audit-strict.
AUDIT_EXCEPTIONS = (
    (
        "SBOM-V19.cdx.json",
        "historical V19 inventory; the shipped and OSV-scanned SBOM is SBOM-V20.cdx.json, which is stamped",
    ),
    (
        "scripts/check-r119-scope.mjs",
        "R119 revision check asserts the exact historical edit text, including the version of that revision",
    ),
    (
        "scripts/check-update-signing.mjs",
        "fixture input for the signing regression test; the version value is arbitrary test data",
    ),
    (
        "ui-tests/*-fixture.tsx",
        "mocked IPC payload for a UI regression fixture; the version value is test data, not the product version",
    ),
)


class StampError(RuntimeError):
    pass


def read_text(path: Path) -> str:
    # Path.read_text() только с Python 3.13 принимает newline=; сборка идёт на 3.12,
    # поэтому читаем через open(), сохраняя байты строк без преобразования концов строк.
    with open(path, encoding="utf-8", newline="") as stream:
        return stream.read()


def write_text(path: Path, text: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as stream:
        stream.write(text)


def strip_line_endings(text: str) -> str:
    return text.replace("\r\n", "\n")


class Report:
    def __init__(self) -> None:
        self.applied: list[dict] = []
        self.skipped: list[dict] = []
        self.audit: list[dict] = []
        self.exceptions: list[dict] = []
        self.used_exceptions: set[str] = set()

    def rule(self, path: str, occurrences: int, detail: str = "") -> None:
        self.applied.append({"path": path, "occurrences": occurrences, "detail": detail})

    def skip(self, path: str, reason: str) -> None:
        self.skipped.append({"path": path, "detail": reason})

    def exception(self, path: str, line: int, text: str, reason: str) -> None:
        self.exceptions.append({"path": path, "line": line, "text": text, "reason": reason})

    def as_dict(self) -> dict:
        return {
            "applied": self.applied,
            "skipped": self.skipped,
            "audit": self.audit,
            "exceptions": self.exceptions,
        }


def sub_count(pattern: re.Pattern[str], text: str, replace) -> tuple[str, int]:
    return pattern.subn(replace, text)


def apply_regex_rule(
    root: Path,
    relative: str,
    pattern: re.Pattern[str],
    replacement,
    report: Report,
    *,
    required: bool = True,
    detail: str = "",
) -> None:
    path = root / PurePosixPath(relative)
    if not path.is_file():
        if required:
            raise StampError(f"{relative}: managed file is missing")
        report.skip(relative, "file is absent")
        return
    original = read_text(path)
    updated, count = sub_count(pattern, original, replacement)
    if count == 0:
        if not required:
            report.skip(relative, "no version literal")
            return
        raise StampError(f"{relative}: version rule did not match ({detail or 'pattern not found'})")
    write_text(path, updated)
    report.rule(relative, count, detail)


def version_rules(old: str, new: str) -> list[tuple[str, re.Pattern[str], str, str]]:
    return [
        (
            "src-tauri/tauri.conf.json",
            re.compile(r'(?m)^(\s*"version"\s*:\s*")' + re.escape(old) + r'(")'),
            r"\g<1>" + new + r"\g<2>",
            "tauri bundle version (installer PE version)",
        ),
        (
            "src-tauri/Cargo.toml",
            re.compile(r'(?m)^(\s*version\s*=\s*")' + re.escape(old) + r'(")'),
            r"\g<1>" + new + r"\g<2>",
            "client crate version (exe PE version)",
        ),
        (
            "package.json",
            re.compile(r'(?m)^(\s*"version"\s*:\s*")' + re.escape(old) + r'(")'),
            r"\g<1>" + new + r"\g<2>",
            "npm package version",
        ),
        (
            "package-lock.json",
            re.compile(r'("version"\s*:\s*")' + re.escape(old) + r'(")'),
            r"\g<1>" + new + r"\g<2>",
            "npm lock version",
        ),
        (
            "e2e/package.json",
            re.compile(r'(?m)^(\s*"version"\s*:\s*")' + re.escape(old) + r'(")'),
            r"\g<1>" + new + r"\g<2>",
            "e2e harness version",
        ),
        (
            "src-tauri/src/lib.rs",
            re.compile(r'(?m)^(const APP_VERSION: &str = ")' + re.escape(old) + r'(";)'),
            r"\g<1>" + new + r"\g<2>",
            "APP_VERSION constant (diagnostics, IPC handshake, updater currentVersion)",
        ),
        (
            "scripts/build-and-install-windows.mjs",
            re.compile(re.escape(old)),
            new,
            "local build banner",
        ),
    ]


def stamp_crate_manifests(root: Path, old: str, new: str, report: Report) -> None:
    crates = sorted((root / "src-tauri" / "crates").glob("*/Cargo.toml"))
    if not crates:
        raise StampError("src-tauri/crates/*/Cargo.toml: no workspace crates found")
    pattern = re.compile(r'(?m)^(\s*version\s*=\s*")' + re.escape(old) + r'(")')
    for crate in crates:
        relative = crate.relative_to(root).as_posix()
        original = read_text(crate)
        updated, count = pattern.subn(r"\g<1>" + new + r"\g<2>", original)
        if count == 0:
            raise StampError(f"{relative}: crate version rule did not match")
        write_text(crate, updated)
        report.rule(relative, count, "workspace crate version")


def stamp_cargo_lock(root: Path, old: str, new: str, report: Report) -> None:
    relative = "src-tauri/Cargo.lock"
    path = root / PurePosixPath(relative)
    if not path.is_file():
        raise StampError(f"{relative}: managed file is missing")
    lines = read_text(path).splitlines(keepends=True)
    name_pattern = re.compile(r'^name\s*=\s*"([^"]+)"\s*$')
    version_pattern = re.compile(r'^(version\s*=\s*")([^"]+)(")\s*$')
    current: str | None = None
    changed = 0
    for index, line in enumerate(lines):
        stripped = strip_line_endings(line).rstrip("\n")
        name_match = name_pattern.match(stripped)
        if name_match:
            current = name_match.group(1)
            continue
        version_match = version_pattern.match(stripped)
        if version_match and current in OWN_CRATES:
            if version_match.group(2) == new:
                continue
            newline = line[len(stripped):]
            lines[index] = f'{version_match.group(1)}{new}{version_match.group(3)}{newline}'
            changed += 1
    if changed == 0:
        raise StampError(f"{relative}: no project package entry was stamped")
    write_text(path, "".join(lines))
    report.rule(relative, changed, "Cargo.lock project packages")


def stamp_mutex(root: Path, report: Report) -> None:
    """Drop the version from the single-instance mutex name.

    A versioned mutex lets a stale process of an older build keep running next to the
    freshly installed build, which produced two writers on one farm.sqlite3. The schema
    and IPC protocol versions already fence incompatible builds, so the client mutex only
    has to guarantee "one client per user session".
    """
    relative = "src-tauri/src/transactional_core/instance_lease.rs"
    path = root / PurePosixPath(relative)
    if not path.is_file():
        raise StampError(f"{relative}: managed file is missing")
    original = read_text(path)
    versioned = re.compile(r'(const MUTEX_NAME: &str = "Local\\\\KlipperFarmClient-v[^"]*";)')
    updated, count = versioned.subn(
        lambda _match: 'const MUTEX_NAME: &str = "Local\\\\KlipperFarmClient";', original
    )
    if count == 0:
        unversioned = re.compile(r'const MUTEX_NAME: &str = "Local\\\\KlipperFarmClient";')
        if unversioned.search(original):
            report.skip(relative, "mutex name is already version independent")
            return
        raise StampError(f"{relative}: MUTEX_NAME rule did not match")
    write_text(path, updated)
    report.rule(relative, count, "single-instance mutex name without version")


def stamp_security_check(root: Path, report: Report) -> None:
    relative = "scripts/check-security.mjs"
    path = root / PurePosixPath(relative)
    if not path.is_file():
        raise StampError(f"{relative}: managed file is missing")
    original = read_text(path)
    hardcoded = re.compile(r"assert\(pkg\.version===['\"][^'\"]+['\"],'package\.json version mismatch'\);")
    relaxed = "assert(/^\\d+\\.\\d+\\.\\d+$/.test(pkg.version),'package.json version must be a plain SemVer');"
    updated, count = hardcoded.subn(lambda _match: relaxed, original)
    if count == 0:
        if relaxed in original:
            report.skip(relative, "version assertion is already version independent")
            return
        raise StampError(f"{relative}: hardcoded version assertion was not found")
    write_text(path, updated)
    report.rule(relative, count, "removed hardcoded version assertion")


def stamp_literals(root: Path, old: str, new: str, report: Report) -> None:
    for relative in LITERAL_ALL:
        apply_regex_rule(
            root,
            relative,
            re.compile(re.escape(old)),
            new,
            report,
            detail="user-visible version string",
        )
    for relative in OPTIONAL_LITERAL_ALL:
        path = root / PurePosixPath(relative)
        if not path.is_file():
            report.skip(relative, "file is absent")
            continue
        original = read_text(path)
        updated, count = re.subn(re.escape(old), new, original)
        if count == 0:
            report.skip(relative, "no version literal")
            continue
        write_text(path, updated)
        report.rule(relative, count, "launcher banner")


def stamp_sbom(root: Path, old: str, new: str, report: Report) -> None:
    relative = "SBOM-V20.cdx.json"
    path = root / PurePosixPath(relative)
    if not path.is_file():
        report.skip(relative, "file is absent")
        return
    lines = read_text(path).splitlines(keepends=True)
    name_pattern = re.compile(r'"name"\s*:\s*"([^"]+)"')
    changed = 0
    pending = 0
    for index, line in enumerate(lines):
        name_match = name_pattern.search(line)
        if name_match:
            pending = 6 if name_match.group(1) in OWN_CRATES else 0
        if pending > 0:
            updated, count = re.subn(re.escape(old), new, line)
            if count:
                lines[index] = updated
                changed += count
            pending -= 1
            continue
        if any(f":{name}@" in line or f"pkg:cargo/{name}@" in line for name in OWN_CRATES):
            updated, count = re.subn(re.escape(old), new, line)
            if count:
                lines[index] = updated
                changed += count
    if changed == 0:
        report.skip(relative, "no project package entries")
        return
    write_text(path, "".join(lines))
    report.rule(relative, changed, "SBOM project packages")


def project_lock_versions(root: Path) -> dict[str, str]:
    """Версии только собственных пакетов из Cargo.lock.

    Сырой поиск подстроки по Cargo.lock даёт ложные срабатывания: версия стороннего
    крейта может случайно совпасть с целевой (например, smallvec 1.15.2).
    """
    path = root / PurePosixPath("src-tauri/Cargo.lock")
    versions: dict[str, str] = {}
    if not path.is_file():
        return versions
    name_pattern = re.compile(r'^name\s*=\s*"([^"]+)"\s*$')
    version_pattern = re.compile(r'^version\s*=\s*"([^"]+)"\s*$')
    current: str | None = None
    for line in read_text(path).splitlines():
        name_match = name_pattern.match(line.strip())
        if name_match:
            current = name_match.group(1)
            continue
        version_match = version_pattern.match(line.strip())
        if version_match and current in OWN_CRATES:
            versions[current] = version_match.group(1)
    return versions


def verify_no_leftovers(root: Path, old: str, new: str, report: Report) -> None:
    managed = [relative for relative, _, _, _ in version_rules(old, "0.0.0")]
    leftovers = []
    for relative in managed:
        path = root / PurePosixPath(relative)
        if not path.is_file():
            continue
        text = read_text(path)
        for number, line in enumerate(text.splitlines(), start=1):
            if old in line:
                leftovers.append(f"{relative}:{number}: {line.strip()[:120]}")
    # Cargo.lock сверяем по пакетам, а не по подстроке: чужая версия может совпасть.
    stale = {
        name: version
        for name, version in project_lock_versions(root).items()
        if version == old
    }
    if stale:
        leftovers.extend(f"src-tauri/Cargo.lock: {name} = {version}" for name, version in stale.items())
    if leftovers:
        raise StampError("managed files still reference the previous version:\n  " + "\n  ".join(leftovers))


def audit_exception(relative: str) -> tuple[str, str] | None:
    for pattern, reason in AUDIT_EXCEPTIONS:
        if fnmatch.fnmatchcase(relative, pattern):
            return pattern, reason
    return None


def audit(root: Path, old: str, report: Report) -> None:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIT_SUFFIXES:
            continue
        relative = path.relative_to(root)
        if any(part in SKIP_DIRS for part in relative.parts):
            continue
        try:
            text = read_text(path)
        except (UnicodeDecodeError, OSError):
            continue
        relative_posix = relative.as_posix()
        exception = audit_exception(relative_posix)
        for number, line in enumerate(text.splitlines(), start=1):
            if old not in line:
                continue
            entry = {"path": relative_posix, "line": number, "text": line.strip()[:160]}
            if exception is None:
                report.audit.append(entry)
                continue
            pattern, reason = exception
            report.used_exceptions.add(pattern)
            report.exception(relative_posix, number, entry["text"], reason)
    for pattern, reason in AUDIT_EXCEPTIONS:
        if pattern not in report.used_exceptions:
            report.skip(pattern, "reviewed audit exception matched nothing: " + reason)


OPTIONAL_RULE_FILES = (
    "e2e/package-lock.json",
    "ui-tests/package.json",
    "ui-tests/package-lock.json",
)


def stamp_optional_version_files(root: Path, old: str, new: str, report: Report) -> None:
    pattern = re.compile(r'("version"\s*:\s*")' + re.escape(old) + r'(")')
    for relative in OPTIONAL_RULE_FILES:
        apply_regex_rule(
            root,
            relative,
            pattern,
            r"\g<1>" + new + r"\g<2>",
            report,
            required=False,
            detail="auxiliary package version",
        )


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, help="reviewed application tree (work/app)")
    parser.add_argument("--version", help="target version (default: version.json next to this script)")
    parser.add_argument("--from-version", help="current version (default: src-tauri/tauri.conf.json)")
    parser.add_argument("--audit", action="store_true", help="also audit the tree for leftovers")
    parser.add_argument("--audit-strict", action="store_true", help="fail when the audit finds leftovers")
    parser.add_argument("--report", help="write a JSON report to this path")
    args = parser.parse_args()

    root = Path(args.app).resolve()
    if not (root / "src-tauri" / "tauri.conf.json").is_file():
        raise StampError(f"{root}: not an application tree (src-tauri/tauri.conf.json is missing)")

    settings_path = Path(__file__).resolve().parent / "version.json"
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    new = args.version or settings["version"]
    if not SEMVER.match(new):
        raise StampError(f"target version is not a plain SemVer: {new!r}")

    tauri_conf = json.loads(read_text(root / "src-tauri" / "tauri.conf.json"))
    old = args.from_version or str(tauri_conf.get("version", ""))
    if not SEMVER.match(old):
        raise StampError(f"current tauri.conf.json version is not a plain SemVer: {old!r}")

    report = Report()

    if old == new:
        print(f"Version already stamped: {new} (nothing to do)")
    else:
        for relative, pattern, replacement, detail in version_rules(old, new):
            apply_regex_rule(root, relative, pattern, replacement, report, detail=detail)
        stamp_crate_manifests(root, old, new, report)
        stamp_cargo_lock(root, old, new, report)
        stamp_optional_version_files(root, old, new, report)
        stamp_literals(root, old, new, report)
        stamp_sbom(root, old, new, report)
        stamp_mutex(root, report)
        stamp_security_check(root, report)
        verify_no_leftovers(root, old, new, report)
        print(f"Stamped version {old} -> {new} in {len(report.applied)} managed files")

    if (args.audit or args.audit_strict) and old != new:
        audit(root, old, report)
        if report.audit:
            print(f"Audit: {len(report.audit)} unexpected occurrence(s) of {old} remain:")
            for entry in report.audit[:40]:
                print(f"  {entry['path']}:{entry['line']}: {entry['text']}")
            if len(report.audit) > 40:
                print(f"  ... {len(report.audit) - 40} more")
        else:
            print(f"Audit: no unexpected occurrences of {old} remain in the source tree")
        if report.exceptions:
            print(
                f"Audit: {len(report.exceptions)} reviewed occurrence(s) of {old} are test or historical data:"
            )
            for pattern, reason in AUDIT_EXCEPTIONS:
                matches = [
                    entry
                    for entry in report.exceptions
                    if fnmatch.fnmatchcase(entry["path"], pattern)
                ]
                if not matches:
                    continue
                files = sorted({entry["path"] for entry in matches})
                print(f"  {pattern}: {len(matches)} in {len(files)} file(s) — {reason}")

    if args.report:
        Path(args.report).write_text(
            json.dumps(
                {
                    "schema": "klipper-farm-version-stamp-v1",
                    "from": old,
                    "to": new,
                    "app": str(root),
                    **report.as_dict(),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    if args.audit_strict and old != new and report.audit:
        raise StampError(
            f"audit found {len(report.audit)} unexpected version references outside managed files "
            "and reviewed audit exceptions"
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except StampError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
