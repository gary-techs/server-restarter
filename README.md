# E2E External Watchdog

Runs on a separate host (recommended: the Grafana server), checks SSH and MongoDB TCP reachability every 15 seconds, alerts by email after sustained outage, and can request an E2E Cloud reboot after a confirmed outage.


## Setup
1. Install Node.js 18+.
2. Copy `.env.example` to `.env` and fill in credentials and SMTP values.
3. Confirm the Mongo port that is reachable from the watchdog host. Change `MONGO_PORT` if it is not 27017.
4. In E2E API credentials, grant the API token only the permissions needed for node actions (reboot). Keep `.env` private and out of source control.
5. Install dependencies and run:
   ```bash
   npm install
   npm start
   ```

## Safety behavior
- Checks every 15 seconds.
- Only considers the target fully down if both SSH and Mongo TCP checks fail.
- Sends an outage alert after 2 minutes.
- Reboot request is delayed until the configured outage duration (default 2 minutes).
- Reboot cooldown defaults to 30 minutes.
- Recovery is declared after 3 consecutive healthy checks.
- State persists in `logs/state.json` across restarts.

## Important
This is a TCP reachability watchdog, not a full MongoDB authenticated health check. If Mongo TCP is reachable but MongoDB is wedged internally, this may not detect it. A later improvement can add an authenticated Mongo ping over SSH or a small health endpoint.
