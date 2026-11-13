#!/usr/bin/env python3
"""AI usage tracker: end-of-day email.

Reads today's usage from Supabase and sends one summary email through Gmail.
Standard library only (Python 3.9+).

Settings come from environment variables:
  SUPABASE_URL, SUPABASE_KEY          same values the collector uses
  GMAIL_USER, GMAIL_APP_PASSWORD      the Gmail account that sends (app password, not your login password)
  REPORT_TO                           where to send it (default: GMAIL_USER)
  REPORT_TZ                           your time zone, e.g. America/Chicago (default: UTC)
  REPORT_HOUR                         send at or after this local hour, 0-23 (default: 21)

It is safe to run every hour: it sends once per day, after REPORT_HOUR.
  --force     send now even if it is early or already sent today
  --dry-run   print the email instead of sending it
"""
import html
import json
import os
import smtplib
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from zoneinfo import ZoneInfo

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_KEY", "")
NAMES = {"claude": "Claude", "codex": "Codex / ChatGPT", "chatgpt": "Codex / ChatGPT", "gemini": "Gemini"}


def sb(path, body=None, prefer=None):
    req = urllib.request.Request(f"{URL}/rest/v1/{path}", method="POST" if body is not None else "GET")
    req.add_header("apikey", KEY)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data, timeout=30) as res:
        text = res.read().decode()
        return json.loads(text) if text else None


def fetch_buckets(since):
    rows, off = [], 0
    while True:  # Supabase returns at most 1000 rows per request
        q = urllib.parse.urlencode({"select": "*", "hour": f"gte.{since.isoformat()}", "order": "hour", "limit": 1000, "offset": off})
        page = sb(f"usage_buckets?{q}")
        rows += page
        if len(page) < 1000:
            return rows
        off += 1000


def fmt(n):
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}k" if n >= 1e3 else str(int(n))


def dur(td):
    m = max(0, int(td.total_seconds() // 60))
    return f"{m // 1440}d {m % 1440 // 60}h" if m >= 1440 else f"{m // 60}h {m % 60}m" if m >= 60 else f"{m}m"


def name(provider, account):
    return f"{NAMES.get(provider.lower(), provider)} · {account}"


def tokens(b):
    return b["input"] + b["output"] + b["cache_write"]


def build(buckets, state, now):
    """Return (subject, plain text, html) for the day that `now` falls in."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = midnight - timedelta(days=7)
    today, week = {}, {}
    for b in buckets:
        t = datetime.fromisoformat(b["hour"].replace("Z", "+00:00"))
        key = (b["provider"], b["account"])
        if t >= midnight:
            d = today.setdefault(key, {"tokens": 0, "replies": 0, "models": {}})
            d["tokens"] += tokens(b)
            d["replies"] += b["messages"]
            d["models"][b["model"]] = d["models"].get(b["model"], 0) + tokens(b)
        elif t >= week_start:
            week[key] = week.get(key, 0) + tokens(b)

    limits = {}
    for r in state:
        d = r.get("data") or {}
        if r["key"].startswith("limits:"):
            limits[(d["provider"], d["account"])] = (d.get("source", ""), d.get("windows", []))
        if r["key"] == "manual":
            for m in d.get("accounts", []):
                if m.get("resets_at"):
                    limits[(m["provider"], m["account"])] = ("manual", [{"label": "Limit", "used_pct": m.get("used_pct", 0), "resets_at": m["resets_at"], "window_minutes": m.get("window_minutes", 300)}])

    total = sum(d["tokens"] for d in today.values())
    usage_rows = []
    for key in sorted(set(today) | set(week)):
        d = today.get(key, {"tokens": 0, "replies": 0, "models": {}})
        avg = week.get(key, 0) / 7
        top = max(d["models"], key=d["models"].get) if d["models"] else "-"
        usage_rows.append((name(*key), fmt(d["tokens"]), str(d["replies"]), fmt(avg), top))

    limit_rows, tips = [], []
    for key in sorted(limits):
        source, windows = limits[key]
        for w in windows:
            left = datetime.fromisoformat(w["resets_at"].replace("Z", "+00:00")) - now
            if left.total_seconds() <= 0:
                limit_rows.append((name(*key), w["label"], "reset", "full allowance available", source))
                continue
            used = w["used_pct"]
            limit_rows.append((name(*key), w["label"], f"{used:.0f}% used", f"resets in {dur(left)}", source))
            length = timedelta(minutes=w.get("window_minutes") or 300)
            elapsed = 100 * (1 - left / length)
            if used >= 90 and w.get("window_minutes", 0) >= 1440:
                tips.append(f"{name(*key)} is at {used:.0f}% of its {w['label'].lower()} limit until it resets in {dur(left)}. Lean on other accounts.")
            elif w.get("window_minutes", 0) >= 1440 and used < elapsed - 25:
                tips.append(f"{name(*key)} has {100 - used:.0f}% of its {w['label'].lower()} allowance left with {dur(left)} to go. Put heavier work here.")

    day = now.strftime("%a %b %-d") if os.name != "nt" else now.strftime("%a %b %d")
    subject = f"AI usage {day}: {fmt(total)} tokens"
    text = [f"AI usage for {day}", "", f"Total today: {fmt(total)} tokens", ""]
    text += [f"{r[0]}: {r[1]} tokens, {r[2]} replies (7-day average {r[3]}/day, mostly {r[4]})" for r in usage_rows] or ["No usage recorded today."]
    if limit_rows:
        text += ["", "Limits right now:"] + [f"{r[0]} {r[1]}: {r[2]}, {r[3]} ({r[4]})" for r in limit_rows]
    if tips:
        text += ["", "For tomorrow:"] + [f"- {t}" for t in tips]

    def table(head, rows):
        th = "".join(f'<th align="left" style="padding:6px 10px;border-bottom:2px solid #ddd">{html.escape(h)}</th>' for h in head)
        tr = "".join("<tr>" + "".join(f'<td style="padding:6px 10px;border-bottom:1px solid #eee">{html.escape(c)}</td>' for c in r) + "</tr>" for r in rows)
        return f'<table cellspacing="0" style="border-collapse:collapse;font-size:14px">{"<tr>" + th + "</tr>"}{tr}</table>'

    body = f'<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;color:#111"><h2 style="margin:0 0 4px">AI usage for {html.escape(day)}</h2><p style="font-size:22px;margin:0 0 16px"><b>{fmt(total)}</b> tokens today</p>'
    body += table(["Account", "Tokens", "Replies", "7-day avg/day", "Top model"], usage_rows) if usage_rows else "<p>No usage recorded today.</p>"
    if limit_rows:
        body += '<h3 style="margin:20px 0 6px">Limits right now</h3>' + table(["Account", "Window", "Used", "Reset", "Source"], limit_rows)
    if tips:
        body += '<h3 style="margin:20px 0 6px">For tomorrow</h3><ul>' + "".join(f"<li>{html.escape(t)}</li>" for t in tips) + "</ul>"
    body += '<p style="color:#777;font-size:12px">Tokens are new input, output and cache writes. Chat-app usage appears only where you entered a reading.</p></div>'
    return subject, "\n".join(text), body


def main():
    force, dry = "--force" in sys.argv, "--dry-run" in sys.argv
    if not URL or not KEY:
        sys.exit("SUPABASE_URL and SUPABASE_KEY are required")
    now = datetime.now(ZoneInfo(os.environ.get("REPORT_TZ") or "UTC"))
    day = now.strftime("%Y-%m-%d")
    if not force:
        if now.hour < int(os.environ.get("REPORT_HOUR") or 21):
            return print(f"Too early ({now:%H:%M} local). Nothing sent.")
        last = sb("usage_state?select=data&key=eq.email:last_sent")
        if last and (last[0].get("data") or {}).get("day") == day:
            return print("Already sent today.")
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    buckets = fetch_buckets((midnight - timedelta(days=7)).astimezone(timezone.utc))
    state = sb("usage_state?select=key,data")
    subject, text, body = build(buckets, state, now)
    if dry:
        return print(f"Subject: {subject}\n\n{text}\n\n--- HTML ---\n{body}")
    user, password = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    if not user or not password:
        sys.exit("GMAIL_USER and GMAIL_APP_PASSWORD are required to send")
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, user, os.environ.get("REPORT_TO") or user
    msg.set_content(text)
    msg.add_alternative(body, subtype="html")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(user, password.replace(" ", ""))
        smtp.send_message(msg)
    sb("usage_state?on_conflict=key", [{"key": "email:last_sent", "data": {"day": day}}], "resolution=merge-duplicates,return=minimal")
    print(f"Sent: {subject}")


if __name__ == "__main__":
    main()
