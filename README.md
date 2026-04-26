# Gmail Job Application Tracker

An Apps Script automation that scans Gmail for job application activity and maintains a Google Sheet pipeline — no servers, no subscriptions, no manual data entry.

Built during my own job search after realizing I was losing track of where I'd applied, who'd ghosted me, and which interviews were coming up.

## What it does

- **Logs new applications** — scans Gmail daily for application confirmation emails and writes them to a Google Sheet with company, role, date, and a deep link back to the email thread.
- **Tracks status changes** — detects interview invites and rejection emails, then updates the matching row. Won't downgrade a row that's already past the new status (e.g. an "Offer" won't get clobbered by a stale "Interview" email).
- **Auto-flags ghosted applications** — applications stuck at "Applied" for 30+ days get auto-flipped to a "Ghosted" status. 14-day stale flag for follow-up reminders.
- **Weekly digest** — every Sunday, emails a summary: how many applications this week, current pipeline by status, stale apps that need follow-up.
- **Backfill** — one-shot function to sweep the last 90 days when you first set it up, so you're not starting from zero.
- **Two view tabs** — `Active` and `Closed` tabs auto-populate via QUERY formulas, giving you filtered views without duplicating data.

## Stack

Google Apps Script (JavaScript) · Gmail API · Google Sheets API · time-driven triggers. That's it. Runs entirely inside Google's free tier.

## Architecture notes

A few design decisions worth surfacing:

- **Gmail labels as state.** Each function applies a label (`JobTracker/Logged`, `JobTracker/Interview`, etc.) to threads it has processed. This makes every operation idempotent — re-running a function won't create duplicates, and the backfill can be re-invoked safely if it hits the execution timeout partway through.
- **Subject-line matching for ingestion, body matching for rejections.** Application receipts and interview invites have predictable subject patterns. Rejection language ("unfortunately", "we regret to inform") is too common in subjects to trust, so rejection detection requires a body match.
- **Status updates use a company-name lookup.** When an interview/rejection email comes in, the script finds the most recent matching row by company name (with terminal-state filtering so closed apps don't get reopened).
- **Time budget on the backfill.** Apps Script has a 6-minute execution limit on consumer Gmail. The backfill function checks elapsed time on each iteration and exits cleanly before timeout. Re-running picks up where it left off via the label-based dedup.

## Setup

1. Create a new Google Sheet. Copy its ID from the URL.
2. Open Extensions → Apps Script. Paste `job-tracker.gs` into the editor.
3. Replace `SHEET_ID` at the top with your Sheet's ID.
4. Run `setupSheet()` once. This creates the headers, view tabs, and Gmail labels, and prompts for the OAuth permissions the script needs.
5. Run `backfillApplications()` to ingest the last 90 days. Re-run if it logs a timeout — it'll resume.
6. Set up triggers (Apps Script editor → Triggers):

   | Function | Type | Time |
   |---|---|---|
   | `logJobApplications` | Day timer | 6–7am |
   | `updateInterviewStatus` | Day timer | 7–8am |
   | `updateRejectionStatus` | Day timer | 7–8am |
   | `flagStaleApplications` | Day timer | 8–9am |
   | `sendWeeklySummary` | Week timer (Sun) | 7–8pm |

## Limitations and what I'd add for production

This is a personal-scale script, not production code. Honest list of what's missing:

- **No tests.** Apps Script's testing story is rough but not impossible — would add unit tests around the keyword-matching and company-extraction helpers, since those are where most bugs hide.
- **No structured error handling.** A Gmail API quota exhaustion or a malformed sender header will throw and stop the run. Production version would log to a separate `Errors` tab and continue.
- **Sheet ID is hardcoded.** Should live in `PropertiesService` so the same script can be deployed across multiple sheets without code changes.
- **Keyword lists are static.** ATS vendors change their boilerplate occasionally. A self-tuning version could flag low-confidence matches for manual review and learn from corrections.
- **Company extraction is regex-based and brittle.** Works most of the time, fails on weirdly-formatted sender names. An LLM-based extraction step would be more robust at the cost of API calls and complexity.

## Why this exists

Most "job tracker" tools are either Chrome extensions that scrape job boards (privacy-hostile) or paid SaaS products (overkill). Gmail already has every signal you need — the automation just connects the dots.

Built by a Senior Systems and Infrastructure Administrator while job searching. The same pattern (time-driven triggers + API state via labels/tags + a spreadsheet as a poor-man's database) generalizes well to other internal IT automations: license renewal tracking, certificate expiry alerts, ticket SLA monitoring.

## License

MIT
