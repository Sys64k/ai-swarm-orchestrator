# Installation

Setting up the Hub machine and worker machines, keeping them running and up to date, and reaching the console from your phone.

## Hub machine

Install from source (this repository) and build the distributable package once:

```bash
git clone git@github.com:Sys64k/ai-swarm-orchestrator.git aso && cd aso
npm install
npm run package            # builds everything + release/aso.tgz (the package workers install)
npm link -w @aso/cli       # puts `aso` on your PATH (or use: npm run aso -- <command>)
```

Start the Hub, in Docker (recommended) or directly:

```bash
aso start-hub --docker    # first run builds the image (a few minutes)
aso start-hub             # without Docker
```

The Hub works on **projects** in `~/aso-projects` (change it with `--root`). Each git
repository directly inside that folder is a project, named after its folder. Create new
projects from the console or with `POST /api/projects`, optionally connected to a GitHub
repository. To bring in a repository from elsewhere, move or clone it into the folder; it
needs at least one commit on `main`. See
[Projects](using-aso.md#projects).

The first start generates the **ASO token** (`~/.config/aso/token`, readable only by you).
Every worker, the CLI and the dashboard need it. Show it with:

```bash
aso token
```

You get:

- **Console:** `http://<hub-ip>:7421`, built for phones first. Sign in with a one-time link
  from `aso console-link` (or its QR code); the browser stays signed in. See
  [The console](using-aso.md#the-console).
- **Hub endpoints:** the API, WebSocket and Git endpoint at `<hub-ip>:7420`.
- **Architect:** runs in tmux (`tmux attach -t aso-architect`).
- **Container ownership:** in Docker the container runs as your user ID, so files the Hub
  writes into your project keep your ownership.

### Keep the Hub running (systemd)

`aso start-hub` runs only as long as its terminal. On Linux, install it as a systemd user
service instead, with the same options:

```bash
aso hub-service install --docker   # same options as start-hub
aso hub-service status
aso hub-service logs -f            # the Hub's, the console's and the Architect's output
aso hub-service restart            # after rebuilding or updating aso
aso hub-service uninstall
```

- **Starts at boot, restarts on failure.** `~/.config/systemd/user/aso-hub.service` runs the
  `aso` you installed it with, using your current `PATH`, and restarts 10 s after any exit.
  Lingering is turned on as for the worker service, so it runs without a login.
- **Options:** the unit keeps the options you typed, plus the projects folder as an absolute
  path. Everything else is read again at each start: the token file, `ANTHROPIC_API_KEY` and
  `ASO_*` settings from `~/.config/aso/.env` (or the checkout's `.env`). A key that is only
  exported in your shell does not reach the service; the install warns about that.
- **The Architect runs as a child process** of the service instead of in tmux, so its output
  is in `aso hub-service logs`. It is started again 10 s after it exits.
- **One Hub per port.** The install refuses while another Hub answers on the port: stop that
  one first.

### The database

The Hub keeps its tasks, plans, agent conversations and model usage totals in **PostgreSQL**.

- **With `--docker`, it brings its own.** Compose starts a `postgres:17-alpine` container
  (`db`) next to the Hub. Its data is in the `aso-db` Docker volume. It isn't published on any
  port: only the Hub reaches it.
- **The password** is made on the first start and kept in `~/.config/aso/db-password` (mode
  600). Keep it: the database takes it when its volume is first created, so a new password
  later would lock the Hub out.
- **Your own database** (on another machine, or a managed one in the cloud):
  `--database-url postgres://user:password@host:5432/db`, or `ASO_DATABASE_URL` in
  `~/.config/aso/.env`. The Hub creates and updates its tables itself at start; the user needs
  rights to create tables in that database.
- **Without Docker and without a database URL,** the Hub keeps them in files as before: each
  project's `.git/aso/state.json`, and conversations in `~/aso-projects/.aso/`.
- **What stays in files either way:** settings and keys (`~/aso-projects/.aso/`), and each
  task's transcript and QA screenshots (the project's `.git/aso/`).

**Moving from files to the database** is automatic. On its first start with a database, the Hub
imports each project's `state.json` and the saved conversations, once, and logs what it
imported. The files are left as they were, as a backup.

**Backing up and moving it.** One command copies everything into a file, and one puts it into
another database:

```bash
docker exec aso-db-1 pg_dump -U aso -Fc aso > aso-backup.dump
pg_restore -d postgres://user:password@new-host:5432/aso --no-owner aso-backup.dump
```

Then start the Hub with `--database-url` pointing at the new database.

## Worker machines

Workers install the package the Hub serves. No clone, build or npm registry access is needed.
Each machine joins with **its own worker key**: on the Hub machine, `aso worker-key new` (or
**Worker machines → Add a machine** in the console) prints a one-time code and what to run:

```bash
curl -fo /tmp/aso.tgz http://192.168.1.10:7420/dist/aso.tgz && npm install -g /tmp/aso.tgz
aso service install --join <code>
```

### Finding the Hub on the LAN

On the Hub's network, or anywhere in your Tailscale network, a worker needs no address. Without
`--hub`, it broadcasts a question on UDP port 7419 and, when Tailscale runs on it, also asks
each online machine in your tailnet directly (broadcasts don't cross Tailscale). The Hub's
machine answers with the Hub's address; a LAN answer is preferred over a tailnet one. The worker asks again
whenever it can't reach the Hub, so it follows the Hub to a new address (a new DHCP lease, say)
within seconds, and the Hub's machine needs no fixed IP.

- **Only the Hub that knows this machine's key, or the join code, can answer.** The answer
  carries a proof made with that credential and the addresses it comes from, and the worker
  connects only to an answer that checks out. A machine on the LAN pretending to be the Hub
  never gets the key. A Hub that doesn't know the credential stays silent.
- **It follows the worker too.** A laptop that leaves home keeps working over Tailscale and
  goes back to the LAN when it returns: every reconnect asks again.
- **`aso find-hub`** prints where the Hub is and whether it found it on the LAN or over
  Tailscale (`--join <code>` before the machine has a key), or what to check if it didn't.
- **An address you give wins.** With `--hub`, the worker uses only that address, as before.
  Workers reached through `wss://` need it.
- **Over Tailscale, the firewall usually needs nothing:** Tailscale's own rules let traffic in
  on `tailscale0` before ufw sees it (tested with ufw active and only a LAN rule for UDP 7419).
  If `aso find-hub` says no Hub answered from the online Tailscale peers, let UDP 7419 in on
  the Hub's machine: `sudo ufw allow in on tailscale0 to any port 7419 proto udp`. The Hub's own
  port needs no rule when the Hub runs in Docker, since Docker's published ports bypass ufw.
- **What can stop it:** a firewall on the Hub's machine that drops UDP 7419, Wi-Fi client
  isolation, or a VPN on the worker. With NordVPN connected, run
  `nordvpn set lan-discovery on`, or give `--hub`.
- **The Hub side** answers from `aso start-hub` on the host, outside any container, because
  broadcasts don't reach a container on Docker's bridge network. `--discovery-port` changes the
  port, and `--no-discovery` turns it off.

- **A worker key only does worker work:** the worker connection, and the projects' Git (pushes
  to task branches only). It can't plan, approve, merge, deploy or read the API, so a machine
  that is lost or compromised doesn't hand over the Hub.
- **One key per machine, revocable:** `aso worker-keys` lists them (connected, last seen),
  `aso worker-key revoke <id>` (or **Revoke** in the console) disconnects that machine at once
  and keeps it out. The Hub stores only a hash of each key; the machine keeps its key in
  `~/.config/aso/worker-key` (mode 600).
- **The join code** works once, for 30 minutes. `--name` labels the key (default: the
  machine's hostname).
- Workers that use the Hub's main token (`ASO_TOKEN`) keep working; `aso status` and the console
  say which workers use it, so you can move them to keys.

### Workers anywhere

A worker connects out to the Hub, so it needs no open port, wherever it is. What matters is how
its traffic gets there:

- **Tailscale (recommended for your own machines):** put the Hub machine and the worker in the
  same tailnet, and run the one-line join command from the console's **Add a machine** (or
  `aso worker-key new` on the Hub) on the new machine. It finds the Hub over the tailnet by
  itself (see [Finding the Hub](#finding-the-hub-on-the-lan)); open the console at its tailnet
  address, so the command downloads aso from there. WireGuard encrypts everything end to end,
  and nothing of the Hub faces the internet.
- **From the internet: the worker gateway.** For machines outside your tailnet (a friend's PC,
  a cloud machine), the Hub opens a second port that serves **only** what a worker needs: the
  worker connection, Git, the aso package and joining. It takes **worker keys only**, never the
  Hub's main token, so the API and the console stay private. Put a TLS tunnel in front of it;
  with Tailscale Funnel no router port is opened and no domain is needed:

  ```bash
  aso hub-service install ... --gateway-port 7423 \
    --gateway-url wss://agent007.tailc9777f.ts.net:10000   # its public address, for join commands
  tailscale funnel --bg --https=10000 http://127.0.0.1:7423
  aso worker-key new --internet          # or: Add a machine in the console, "joins from the internet"
  ```

  The first `tailscale funnel` asks you to allow Funnel for the machine in your tailnet's
  settings. The last command prints the one line to run on the new machine: it downloads aso
  over HTTPS and keeps the `wss://` address, since there's no discovery on the internet. An
  address that keeps trying wrong keys or join codes (20 in 10 minutes) is refused for a while;
  the address is the tunnel's `X-Forwarded-For`, trusted only from a proxy on the Hub's machine.
- **Machines you don't control:** see [below](#machines-you-dont-control).
- **TLS of your own:** with any other `wss://` address (a reverse proxy or tunnel with HTTPS in
  front of the gateway or the Hub's port), the worker connection, Git and updates all use TLS.
- **Plain `ws://` over the internet is refused.** If the Hub's address resolves to a public IP
  and the address isn't `wss://`, the worker stops with the reason, because the key, the code and
  every job would cross the internet unencrypted. `--allow-insecure` overrides that.
- Model calls go through the Hub: workers never hold the Anthropic key.

Workers need **Docker**, usable by the worker's user (in the `docker` group). Every command a
job runs goes into a throwaway container: agent commands, `npm ci` with its install scripts,
and QA tests. That container sees only the task checkout. The first start builds the sandbox
image, which is about 2 GB: Node plus the libraries headless Chromium needs. See
[SECURITY.md](../SECURITY.md#agents-and-their-code). Without Docker, `--sandbox none` runs those commands
directly on the machine instead.


### Machines you don't control

A friend's PC or a volunteer's machine can work for the swarm with a key that's limited to
what it should do. Give the limits when you invite it (`aso worker-key new`, or **Add a machine** in the console,
which has the same choices), or change them later (`aso worker-key set <id>`, or **Trust**/**Untrust** on the console's machines page):

```bash
aso worker-key new --address wss://agent007.tailc9777f.ts.net:10000 \
  --untrusted --projects aso-ui --budget 10
```

- **`--untrusted`:** its machine only builds. QA, which runs the tests, always runs on a
  trusted machine (yours), so code from a machine you don't control is checked on one you do.
  The acceptance check and your review still apply.
- **`--projects`:** it gets jobs from, and can clone, only those projects.
- **`--budget`:** model calls go through the Hub on your keys, so its jobs cost you. Once
  they've caused that many dollars of model calls (estimated), its machine gets no more jobs and
  its agents no more model calls. `aso worker-keys` shows what each key has spent.
- **What it never gets:** model keys, your GitHub token, the Hub's token, or other projects.
  Every job runs in a Docker sandbox on its machine, and it can push only its own task branches.

Keys from before these limits, and machines connected with the Hub's own token, are trusted
for every project with no budget.

**Each key's track record** shows how far to trust its machine: how many builds it pushed
that checked out, how often QA passed them, how often the acceptance check found them complete,
how often its agent gave up or it went offline during a job it had started, and how many QA
runs it did for others. `aso
worker-keys` and the console's machines page show it, e.g. `12 builds · QA passed 9 of 11 ·
acceptance met 8 of 9 · 1 failed`. It's counted as jobs end, from when the Hub started keeping
it; it informs you, and changes nothing by itself. It reflects the models that worked on that
machine's jobs too, since the machine runs the tools and the Hub's models do the thinking.
For every machine (keys or not), each model and each desk, see
[track records](models.md#track-records-how-each-model-has-done).
### Keep a worker running (systemd)

On Linux, install the worker as a systemd user service instead of starting it by hand. It
starts at boot, restarts if it crashes, and `aso update` restarts it on the new version:

```bash
aso service install   # same options as start-worker; finds the Hub on the LAN without --hub
aso service status
aso service logs -f
aso service uninstall
```

- **Where it lives.** `aso service install` writes `~/.config/systemd/user/aso-worker.service`.
  The unit runs the `aso` you ran it with, using your current `PATH` (so it finds Docker and
  git like your shell does), and restarts 10 s after any exit.
- **The token stays out of the unit file.** If the token comes from `~/.config/aso/.env` or
  the token file, the worker reads it there as usual. One passed with `--token` or only set in
  your shell is written to `~/.config/aso/worker.env` (mode 0600), which only the service
  reads.
- **Running without a login.** It enables lingering (`loginctl enable-linger`), so the worker
  runs at boot without you logging in and keeps running after you log out. If your system
  needs root for that, it prints the `sudo` command to run once.
- **To change options,** run `aso service install` again with the new ones.
- **One worker per work directory.** A worker locks its work directory (`worker.lock`), so a
  second `aso start-worker` on the same machine refuses to start while the service runs, and
  says which pid holds it. Stop the other one, or give the second worker its own `--work-dir`.
  A lock left by a crashed worker, or from before a reboot, is taken over automatically.

## Updating

Run `aso update` on any machine:

- **Installed packages:** fetches the Hub's package if its version differs, verifies its
  SHA-256, and installs it.
- **Source checkouts:** `git pull`, `npm ci` and a rebuild.

To roll out a new version, update the Hub machine, run `npm run package` there, and restart
the Hub (`aso hub-service restart` for the service; `aso update` on a Hub installed from the
package restarts the service itself). Workers then update themselves (below); run `aso update --hub <hub-ip>` on the
others. A worker installed with `aso service install` is restarted on the new version
automatically; restart others yourself.

Workers and the Architect report the build they run (`0.1.0+<commit>`; a source checkout
reports its commit, with `-dirty` for uncommitted changes). When it differs from the package
the Hub serves, the console marks the worker **Update**.

### Automatic worker updates

A worker installed from the Hub's package and run by `aso service install` updates itself.
When it connects on another build than the one the Hub serves, the Hub gives it no new jobs,
lets its current ones finish, and then tells it to update. The worker downloads the Hub's
package, checks its SHA-256, installs it, and exits; systemd starts it on the new build a few
seconds later. The console shows **Update after job** or **Updating** meanwhile, and
**Cancel update** stops one that is still waiting for a job.

- **A failed install** (npm error, checksum mismatch) leaves the worker on its old build,
  taking jobs again. The console shows the error, and the Hub does not try that build on that
  machine again; run `aso update` there.
- **A worker that comes back on its old build** after two updates is left alone the same way.
- **Not updated automatically:** source checkouts (they follow their git remote, not the Hub)
  and workers started by hand. The console says to run `aso update` on them.
- **To turn it off,** set `ASO_AUTO_UPDATE=0` for the Hub.

### Automatic Hub updates

A Hub installed with `aso hub-service install --update-from <git-url>` follows that
repository's `main` itself:

1. **Every 5 minutes** it asks the repository for `main`, with the Hub's own git setup (SSH
   agent, keys, credential helpers). **A newer commit that changes only documentation** (Markdown,
   `docs/` apart from `docs/openapi.json`, `.github/`, `LICENSE`) is left alone: nothing to build
   or restart for, and the next code change brings it along. Any other newer commit is checked
   out in its own clone
   (`~/.local/share/aso/hub/build/src`), installed with `npm ci`, tested with `npm test` and
   packaged. Those three get none of the Hub's variables (tokens, API key) and a home folder of
   their own, but they run as you: this is not a sandbox, so merge into the followed branch only
   what you would run on the Hub machine.
2. **It installs the package beside the running version** (`~/.local/share/aso/hub/versions/`).
   The service runs whichever version `~/.local/share/aso/hub/current` points at.
3. **It waits until a restart interrupts nothing:** no task assigned, at work, in QA or being
   merged, no model call under way, no deploy running, no plan being made and no failure being
   read by the product owner. A swarm that is never idle still updates: after 30 minutes
   (`ASO_UPDATE_MAX_WAIT_MIN`; `0` means at once) it restarts at the first quiet moment between
   model turns. Agents at work then carry on after the restart, as they do after any (their jobs
   are held for 5 minutes and their conversations kept); only a Hub-side step (an acceptance check,
   a merge), a plan being made, a deploy or a failure being read still holds it back. If `main`
   moved meanwhile, it starts over with the newer commit.
4. **The running version arms a watchdog** (a systemd timer outside the Hub service), points
   `current` at the new version, and restarts the service.
5. **The new version confirms itself** once it has answered as itself for a minute. If it
   hasn't within 15 minutes (it crashed, hung, or never started), the watchdog points `current`
   back at the previous version and restarts. Every start of the service first runs the same
   check with the previous version, so a reboot inside those 15 minutes rolls back too. That commit is never tried again; one whose build
   or tests failed is tried 3 times. The next commit on `main` is tried as usual.
6. **You get a notification** when the Hub has updated, or when an update failed, and
   `GET /api/hub/update` says where it stands. The workers then update from the new Hub as usual.

Set it up once, from a checkout of the version to start from:

```bash
npm run package                                    # the package the service will run
cp .env ~/.config/aso/.env && chmod 600 ~/.config/aso/.env   # the package reads settings from there
aso hub-service install --docker --update-from https://github.com/<you>/ai-swarm-orchestrator.git
```

The install puts the package in `~/.local/share/aso/hub/versions/` and points the service at
it, so the Hub no longer runs from the checkout. A source checkout or a Hub started by hand never
updates itself: both warn and ignore the option.

### Projects that keep a copy of the Hub API

A project that builds on the Hub's API, such as a console of its own, can keep a copy of the
API description in `docs/openapi.json`, for generating its types. When the Hub starts on a
version whose API differs from that copy, it queues a task in the project:

- **The task's branch already has the new copy** as its first commit, by the Hub, so the agent
  starts from the real contract. It is told what changed (operations and schemas added, removed
  or changed), and to regenerate what the project derives from the copy and fix what no longer
  compiles or passes, such as fixtures that miss new required fields. Features on new endpoints
  are left for a plan.
- **It goes through QA and the acceptance check like any task, and usually merges itself.**
  Its criteria ask only what the diff shows (the copy untouched, the generated files
  regenerated, nothing else changed); that it compiles and passes is QA's and CI's to say.
  **Merging itself:**
  its pull request is merged without a person once the acceptance check found **every**
  criterion met (none unclear) and the project's CI **passes** on the commit QA tested. Anything
  less (an unclear criterion, CI failing or missing, a conflict, changes you asked for) waits for
  your review as usual. The task's history says when it merged by itself.
  `--no-auto-merge-syncs` (`ASO_AUTO_MERGE_SYNCS=0`) leaves every one to you.
- **A newer sync replaces an older one:** an unfinished older sync is cancelled, its pull
  request closed, and it can't be retried (the console shows it as superseded).
- **Once per project and version of the API:** a task you cancel isn't queued again, and a copy
  already synced on GitHub (by hand, say) is noticed after catching up.
- Only a `docs/openapi.json` titled "ASO Hub API" counts; other API descriptions are left alone.
  `apiSync: false` (in `startHub`) turns it off.

### Drain and restart from the console

Tap a worker on the console's home page:

- **Drain**: it finishes its current job but gets no new ones, for example before you take
  the machine offline. **Resume** undoes it.
- **Restart**: drains the worker, then restarts it once its job is done (at once when idle),
  on the aso build installed on that machine. **Cancel restart** works until then. The worker
  comes back under a new name a few seconds later.

Restart needs a worker installed with `aso service install`, because systemd is what starts it
again; for a hand-started worker the console says so. The Architect cannot do either: it plans,
and the Hub schedules.

> **Do not edit the target directory by hand while the Hub runs.** The Hub merges approved
> work into its `main` checkout. If that checkout has uncommitted changes or a different branch
> checked out, the merge is refused and the task fails with "merge blocked".

## Remote access with Tailscale

The Hub's ports are only on your LAN. To use the console from anywhere, without exposing it
publicly, put the Hub machine and your phone on the same
[Tailscale](https://tailscale.com) tailnet and serve the console over HTTPS inside it:

```bash
curl -fsSL https://tailscale.com/install.sh | sh   # on the Hub machine
sudo tailscale up --operator=$USER                 # log in once; lets your user manage serve
tailscale serve --bg 7421                          # https://<machine>.<tailnet>.ts.net → console
```

Approve the "enable Serve" link Tailscale prints the first time. It also turns on HTTPS
certificates for the tailnet. Then install the Tailscale app on your phone and sign in with
the same account. The console works from anywhere at `https://<machine>.<tailnet>.ts.net`:

- **Only your tailnet** can reach it.
- **The sign-in cookie is `Secure`.**
- **Redirects keep the HTTPS address,** because the console honours `X-Forwarded-Proto` and
  `X-Forwarded-Host`.
- **Links follow it:** `aso console-link` uses this address automatically while it's being
  served.

`tailscale serve --bg` survives reboots. `tailscale serve --https=443 off` stops it.

## Notices, and notifications on your phone

The Hub tells you when:
- a plan is ready for your approval, or the Architect has questions,
- a task fails, or planning fails,
- a task comes back for a second rework round (and each round after): it is struggling,
- a task at work has made no progress (no event, no model turn) for an hour,
- all of a plan's tasks are merged (or a task submitted on its own is merged),
- a project deployed, or its deploy failed (see [Deploying after a merge](github.md#deploying-after-a-merge)),
- a model provider is on hold (out of credit, a usage limit), and when it works again,
- a worker machine has been offline for 10 minutes, and again when it is back. The Hub
  remembers its machines across restarts, so one that never reconnects is still reported,
- the Hub's own update finished or failed,
- the day's model spending reached $25 (UTC day; `ASO_DAILY_SPEND_ALERT_USD` changes it,
  `0` turns it off).

**Every one of these is kept as a notice**, whether or not any device gets notifications: the
console's **Notices and notifications** page lists them, newest first, and the home page shows
how many are unread. `aso notices` prints them (`--unread`, `--read` to mark them read), and
`GET /api/notices` gives them to any other client. The Hub keeps the latest 500 in
`<projects root>/.aso/notices.json`.

Tapping a notification opens that plan or task (or, for a worker, the home page) in the console. To turn them on, open the console
at its **https** address (Tailscale, above), tap **Notices and notifications** at the bottom of the home
page, then **Turn on notifications**, and **Send a test**. Do this on each device you want
notified.

- **Browsers need https for push,** so the plain LAN address (`http://<hub>:7421`) can't
  turn them on.
- **Android (Chrome):** works in the browser. Installing the console ("Add to home screen")
  is optional.
- **iPhone/iPad:** add the console to the home screen first and open it from there; Safari
  allows push only for installed web apps.
- **Delivery goes through the browser's push service** (Google's for Chrome on Android,
  Apple's for Safari). The message is end-to-end encrypted to your device; the push service
  only sees that a message was sent. The Hub needs outbound internet access to reach it.
- **Keys and subscriptions** are kept in `<projects root>/.aso/push.json` (owner-only
  permissions). Deleting it signs every device out of notifications.
