"""Optional terminal user interface for browsing audit logs (curses, stdlib)."""

from __future__ import annotations

import json
import sys
from typing import Any

try:
    import curses
except ImportError:  # pragma: no cover - platform dependent
    curses = None

from . import core
from .core import AuditlogError, filter_events, parse_rfc3339_utc, read_events


def run_tui(
    path: str,
    kind: str | None = None,
    since: str | None = None,
    until: str | None = None,
) -> int:
    if curses is None:
        print("auditlog tui: error: curses is not available on this platform", file=sys.stderr)
        return 1
    try:
        events, _diagnostics = read_events(path)
    except AuditlogError as exc:
        print("auditlog tui: error: %s" % exc, file=sys.stderr)
        return 1

    since_dt = parse_rfc3339_utc(since) if since else None
    until_dt = parse_rfc3339_utc(until) if until else None
    filtered = filter_events(events, kind, since_dt, until_dt)

    return curses.wrapper(_ui_main, filtered, path)


def _ui_main(stdscr: Any, events: list[dict[str, Any]], path: str) -> int:
    curses.curs_set(0)
    stdscr.keypad(True)
    stdscr.nodelay(False)

    scroll = 0
    selected = 0
    showing_details: dict[str, Any] | None = None

    while True:
        stdscr.erase()
        maxy, maxx = stdscr.getmaxyx()
        if maxy < 3 or maxx < 10:
            stdscr.addstr(0, 0, "terminal too small")
            stdscr.refresh()
            if stdscr.getch() in (ord("q"), ord("Q")):
                return 0
            continue

        # Header.
        title = "auditlog — %s (%d event%s)" % (path, len(events), "s" if len(events) != 1 else "")
        stdscr.addnstr(0, 0, title[: maxx - 1], maxx - 1, curses.A_BOLD)
        hint = "Up/Down: scroll  Enter: details  q: quit"
        stdscr.addnstr(1, 0, hint[: maxx - 1], maxx - 1)

        # Clamp selection and scroll.
        if events:
            selected = max(0, min(selected, len(events) - 1))
        visible = max(maxy - 3, 0)
        if events:
            start = min(scroll, max(0, len(events) - visible))
            if selected < start:
                start = selected
            if selected >= start + visible:
                start = selected - visible + 1
            scroll = start
        else:
            start = 0
            selected = 0

        # Event list.
        for index in range(start, min(start + visible, len(events))):
            event = events[index]
            line = "%d | %s | %s | %s" % (
                event["seq"],
                event["ts"],
                event["kind"],
                str(event.get("message", "")),
            )
            line = line[: maxx - 1]
            if index == selected:
                stdscr.addnstr(2 + index - start, 0, line, maxx - 1, curses.A_REVERSE)
            else:
                stdscr.addnstr(2 + index - start, 0, line, maxx - 1)

        stdscr.refresh()

        # Details popup.
        if showing_details is not None:
            body = json.dumps(showing_details, sort_keys=True, indent=2)
            lines = body.splitlines()
            pad_height = min(len(lines) + 2, maxy - 2)
            pad_width = min(max(len(l) for l in lines) + 2 if lines else 40, maxx - 2)
            pad = curses.newpad(pad_height, pad_width)
            for row, text in enumerate(lines[: pad_height - 1]):
                try:
                    pad.addnstr(row, 0, text[: pad_width - 1], pad_width - 1)
                except curses.error:
                    pass
            top = (maxy - pad_height) // 2
            left = (maxx - pad_width) // 2
            try:
                pad.refresh(0, 0, top, left, top + pad_height - 1, left + pad_width - 1)
            except curses.error:
                pass
            while True:
                ch = stdscr.getch()
                if ch in (ord("q"), ord("Q"), 27, 10, 13):  # q, ESC, Enter
                    showing_details = None
                    break
            continue

        ch = stdscr.getch()
        if ch in (ord("q"), ord("Q")):
            return 0
        elif ch in (curses.KEY_UP, ord("k"), ord("K")) and events:
            selected -= 1
        elif ch in (curses.KEY_DOWN, ord("j"), ord("J")) and events:
            selected += 1
        elif ch in (curses.KEY_NPAGE, ord(" ")) and events:
            selected = min(selected + visible, len(events) - 1)
        elif ch in (curses.KEY_PPAGE,) and events:
            selected = max(selected - visible, 0)
        elif ch in (10, 13) and events:  # Enter
            showing_details = events[selected]
        elif ch in (curses.KEY_HOME, ord("g")) and events:
            selected = 0
        elif ch in (curses.KEY_END, ord("G")) and events:
            selected = len(events) - 1
