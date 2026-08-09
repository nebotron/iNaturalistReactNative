---
name: l
description: Debug and fix the errors and hangs in the app's Firebase logs
---

The app logs to `{CROP_LOG_FIREBASE_URL}/app_log`. `scripts/app_log.py` reads this log.
Read the log, find errors and UI hangs, and fix the underlying issues. If there is
not enough information in the logs to diagnose the issue, add more logs to figure it out.
If there are verbose logs that add little value, remove them.
Do not run `scripts/app_log.py --clear` or otherwise delete log entries when finished.
