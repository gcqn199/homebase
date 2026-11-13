# Usage strategy: don't hit the wall, don't waste the allowance

## The three clocks

| Clock | Who has it | What it means for you |
|---|---|---|
| Short rolling window (about 5 hours) | Claude, Codex/ChatGPT | Starts at your first message, not at a fixed time. Whatever you don't use is gone when it resets. |
| Weekly cap | Claude, Codex/ChatGPT | The scarce one. Burn it early and you are locked out for days. |
| Daily quota | Gemini | Resets once a day. Unused requests are gone. |

Exact limits change and differ by plan, so the tracker reads the real percentages where the tools report them instead of assuming numbers.

So the two failure modes are opposite: **short windows are wasted by under-use, weekly caps are blown by over-use.** Manage them differently.

## Rules of thumb

1. **Follow the tick.** On the dashboard, the dark tick on each bar is how far through the window you are. Fill behind the tick: you have room. Fill past the tick: you are burning faster than the window refills.
2. **Weekly budget is about 14% a day.** If the weekly bar is more than 15 points past the tick, move work to another account for the rest of the day. If it is far behind the tick with a day or two left, that is the time for your biggest jobs.
3. **Switch at 90%, not 100%.** Hitting a limit mid-task costs more than switching early: the next account has to re-read everything. Finish the current step, then move.
4. **Use what expires soonest first.** The "Use next" line does this for you: it picks the account with the most free allowance and the nearest reset, and skips anything near a limit.
5. **Anchor your windows.** Because a 5-hour window starts at your first message, a one-word message at 7:00 gives you windows of 7-12, 12-5 and 5-10 that line up with your day, instead of a window that starts at 9:40 and resets at an awkward 2:40. Stagger accounts (one at 7:00, the next at 9:30) so that when one runs out, another is fresh.
6. **Match the model to the job.** The top models drain limits several times faster. Use them for hard design and debugging; use the mid-tier models for routine edits, summaries and lookups. Use the chat apps for quick questions so the coding tools keep their allowance.
7. **Keep conversations short.** Every reply re-sends the whole conversation. Start a fresh session for each new task and clear or compact long ones. This is usually the biggest single saving.
8. **Keep a "spare capacity" list.** A short list of useful, low-urgency jobs (write tests, tidy docs, review old code, research a purchase). When the dashboard says allowance is about to expire, pull from the list instead of letting it lapse.

## A daily routine

- **Morning:** send the anchor message on your main accounts. Glance at the weekly bars and decide which account carries today's heavy work.
- **During the day:** work on the "Use next" account. Switch when a bar turns red or passes 90%.
- **Last hour of a window with lots left:** run something from the spare capacity list.
- **Evening:** read the email. It shows the day's totals per account and flags which accounts have weekly allowance to burn tomorrow and which to rest.

## Automating it, in stages

Do these in order; each is useful alone.

1. **Notify on reset (ready now).** Set `on_reset` in the collector config to pop up a notification when a window resets, so you know an account is fresh without checking.
2. **Auto-anchor windows.** A scheduled job (cron on Debian, Task Scheduler on Windows) sends a one-word prompt at fixed times through each tool's non-interactive mode, e.g. `claude -p "hi"`, so the windows always start when you want.
3. **Run the spare capacity list automatically.** An `on_reset` script, or a scheduled one late in a window, takes the next job from a text file and runs it headless (`claude -p`, `codex exec`, `gemini -p`) in a scratch folder. Guard rails that matter: only run when the weekly bar is behind the tick, cap each run with a turn or time limit, run one job at a time, and write results to a folder you review rather than letting it push anywhere.
4. **Route by headroom.** A small wrapper script asks the tracker which account is "Use next" and launches that tool/account, so switching is automatic.

Stage 3 is where unattended agents can burn a week's allowance overnight if a job loops, so add it only after you have a week or two of dashboard history and know your normal burn rate.

## One caution

Running several paid accounts with the same provider to get around per-account limits may be against that provider's terms. Check the terms for each service before building automation that rotates between accounts.
