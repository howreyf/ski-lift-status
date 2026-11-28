"""Breakage alerts: open a GitHub issue when a resort's scraper looks broken, and close it
again once the resort works. GitHub emails the repository owner about new issues.

Two kinds of problem:
    down   the resort's status page has failed on every run for DOWN_HOURS hours or more
           (site unreachable, blocking GitHub's servers, or the page changed so much that
           the parser finds nothing)
    drop   today's daily record lists far fewer lifts or runs than the most seen earlier
           this season (the page layout probably changed and the parser misses some)

run.py (with --alerts FILE) writes the problems it found plus the checks it was able to
make; the GitHub workflow then runs `python -m scraper.alerts FILE`, which uses the `gh`
command line tool to create and close issues. One open issue per problem, never duplicates.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

DOWN_HOURS = 6       # alert when a resort has failed for this long
DROP_SHARE = 0.75    # alert when fewer than 75% of the usual lifts/runs are listed
LABEL = "scraper alert"
KEY_RE = re.compile(r"<!-- alert-key: (\S+) -->")


def _jst(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%d %b %H:%M JST").lstrip("0")


# ---------------------------------------------------------------- finding problems

def down_problem(resort: dict, entry: dict | None, now: datetime) -> dict | None:
    """The resort's page has failed continuously for DOWN_HOURS (from live.json's failing_since)."""
    since = (entry or {}).get("failing_since")
    if not since or now - datetime.fromisoformat(since) < timedelta(hours=DOWN_HOURS):
        return None
    name, rid = resort["name"], resort["id"]
    return {
        "key": f"down:{rid}",
        "title": f"{name}: status page has failed since {_jst(since)}",
        "body": (
            f"The scraper hasn't been able to read **{name}**'s status page since **{_jst(since)}**; "
            f"every run since then has failed.\n\n"
            f"Last error:\n```\n{(entry or {}).get('error', 'unknown')}\n```\n"
            f"Status page: {resort['url']}\n\n"
            "The website still shows the last status it got, with a warning that it may be out of date.\n\n"
            "**What to check:** open the status page in a browser. If it loads normally, the resort's "
            "site is probably refusing GitHub's servers. If the page looks different from before, "
            f"the parser (`scraper/parsers/{resort['parser']}.py`) needs updating.\n\n"
            "This issue closes by itself when the page works again."
        ),
    }


def drop_problems(resort: dict, result: dict, season: dict, today: str) -> list[dict]:
    """Today's lifts/runs count is well below the most this resort listed earlier this season."""
    if not result.get("ok"):
        return []
    rid, name = resort["id"], resort["name"]
    earlier = [d["results"][rid] for d in season["days"]
               if d["date"] != today and d["results"].get(rid, {}).get("ok")]
    problems = []
    for kind in ("lifts", "runs"):
        usual = max((len(r.get(kind) or []) for r in earlier), default=0)
        found = len(result.get(kind) or [])
        if usual and found < usual * DROP_SHARE:
            found_text = (f"only **{found} {kind}**" if found else
                          f"**no {kind}**" + (" (the runs page may have failed)" if kind == "runs" else ""))
            problems.append({
                "key": f"drop-{kind}:{rid}",
                "title": f"{name}: only {found} of the usual {usual} {kind} found",
                "body": (
                    f"Today's record ({today}) for **{name}** has {found_text}, but earlier this season "
                    f"the page listed up to **{usual}**.\n\n"
                    "The resort's page layout has probably changed, so the parser "
                    f"(`scraper/parsers/{resort['parser']}.py`) may be missing {kind}. "
                    f"Status page: {resort.get('runs_url') if kind == 'runs' and resort.get('runs_url') else resort['url']}\n\n"
                    f"This issue closes by itself when a daily record has the usual number of {kind} again."
                ),
            })
    return problems


def write_report(path: Path, problems: list[dict], checked: list[str], now_iso: str) -> None:
    """`checked`: the problem keys this run was able to test (a key that was checked and
    isn't a problem any more gets its issue closed)."""
    path.write_text(json.dumps({"time": now_iso, "problems": problems, "checked": checked},
                               ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------- GitHub issues

def plan(open_issues: list[dict], report: dict) -> tuple[list[dict], list[tuple[int, str]]]:
    """Which problems need a new issue, and which open issues (number, key) can be closed."""
    open_keys = {}
    for issue in open_issues:
        m = KEY_RE.search(issue.get("body") or "")
        if m:
            open_keys[m.group(1)] = issue["number"]
    current = {p["key"] for p in report["problems"]}
    create = [p for p in report["problems"] if p["key"] not in open_keys]
    close = [(n, k) for k, n in open_keys.items() if k in report["checked"] and k not in current]
    return create, close


def _gh(*args: str) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def main(argv: list[str]) -> int:
    path = Path(argv[0]) if argv else None
    if not path or not path.exists():
        print("No alert report (the scraper didn't get that far); nothing to do.")
        return 0
    report = json.loads(path.read_text(encoding="utf-8"))
    owner = os.environ.get("OWNER")  # mentioned in new issues so GitHub surely notifies them

    _gh("label", "create", LABEL, "--color", "d93f0b", "--force",
        "--description", "Opened automatically when a resort's scraper looks broken")
    issues = json.loads(_gh("issue", "list", "--label", LABEL, "--state", "open",
                            "--json", "number,body", "--limit", "200"))
    create, close = plan(issues, report)
    for p in create:
        body = f"{p['body']}\n\n{f'cc @{owner}' if owner else ''}\n<!-- alert-key: {p['key']} -->"
        print("Opening issue:", p["title"])
        _gh("issue", "create", "--title", p["title"], "--body", body, "--label", LABEL)
    for number, key in close:
        print(f"Closing issue #{number} ({key}): working again")
        _gh("issue", "close", str(number), "--comment",
            f"Working again (checked {_jst(report['time'])}). Closed automatically.")
    if not report["problems"] and not close:
        print("No problems.")
    elif not create and not close:
        print(f"No change: {len(report['problems'])} problem(s), all already have an open issue.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
