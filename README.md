# ohmybug-status

The outside uptime probe behind [ohmybug.ai/status](https://ohmybug.ai/status/).

A scheduled GitHub Actions workflow runs `probe.mjs` every 5 minutes (GitHub adds 5–15 minutes of jitter, so samples
land about every 5–15 minutes). Each run reads `https://mcp.ohmybug.ai/healthz` and `https://mcp.ohmybug.ai/site/status`
with a 10 second timeout and records one sample `{t, ok, hunting, ms}`:

- `samples.json` holds the raw samples of today and yesterday (UTC).
- `history.json` holds up to 90 daily buckets `{day, samples, ok, degraded}`. `ok` counts operational samples,
  `degraded` counts samples where the service answered but did not take new hunts; the rest were down.

The status page reads `history.json` straight from this repository:
`https://raw.githubusercontent.com/OhMyX-AI/ohmybug-status/main/history.json`.
The workflow commits only when the files changed, as the `github-actions[bot]` identity.

Check the roll-up locally with `node probe.mjs --self-test` (Node 20 or newer, no dependencies).

## Setup (once)

1. Create the **public** repository `OhMyX-AI/ohmybug-status` on GitHub, with no README, license or .gitignore.
2. Push these files, with an OhMyX author email on the first commit:

   ```bash
   cd ohmybug-status
   git init -b main
   git add .
   git -c user.name='OhMyX' -c user.email='<your-name>@ohmyx.ai' commit -m 'Uptime probe for ohmybug.ai/status'
   git remote add origin https://github.com/OhMyX-AI/ohmybug-status.git
   git push -u origin main
   ```

3. In the repository's **Settings → Actions → General**, allow actions to run, and under **Workflow permissions**
   choose **Read and write permissions** (the workflow commits `history.json`).
4. Open **Actions → probe → Run workflow** once. When it finishes, `history.json` exists and the status page shows
   the 90-day bars on its next load.

GitHub pauses scheduled workflows in a repository with no activity for 60 days; the probe's own commits count as
activity, so it keeps itself running.
