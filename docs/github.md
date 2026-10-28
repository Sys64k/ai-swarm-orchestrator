# GitHub and deploys

Pull requests you review, pushing `main` to GitHub, and deploying a project after each merge.

## Pushing to GitHub

### Pull requests you merge

When a project's `origin` is on GitHub and the Hub has a token (`ASO_GIT_TOKEN`, below), no
task reaches `main` without you. After QA passes, the Hub pushes the task's branch and opens a
pull request describing the task, its acceptance criteria, what the agent says it did (its whole
summary), files, QA result, the models it was built on (the one on trial marked), the acceptance
check and cost. Your
phone gets a notification, and the task shows **Review** under *Needs you* in the console.

**Review in the console.** The task's page opens on its **Changes**: every file it changes,
with the patch. Above them, *Your review* lists the pull request's checks (GitHub Actions and
other CI) and offers:

| You… | The task |
|---|---|
| **Approve and merge** | The Hub merges the pull request on GitHub, its `main` catches up, and tasks that depend on it start. With checks failing, still running or unreadable, the button says **Merge anyway** (or **Merge without waiting**) and asks first |
| **Ask for changes**, with what should change | goes back to an agent with your words, and the pull request gets a comment saying so. Its new commits go through QA and update the same pull request, which waits for you again. These rounds have no limit |
| **Cancel task** | is cancelled, and its pull request closed |

**Or review on GitHub,** where the same decisions work:

| You… | The task |
|---|---|
| **Merge** the pull request | is merged. The Hub's `main` catches up with GitHub's, and tasks that depend on it start |
| Submit a review with **Request changes**, or with **Comment** on a pull request opened as you | goes back to an agent with your review and its comments on the code, as above |
| **Close** the pull request | is cancelled |

The Hub opens pull requests as the token's owner, usually you, and GitHub lets no one request
changes on their own pull request: there the review form offers only **Comment**, so a
submitted Comment review from you sends the work back too. Comments in the conversation (not
in a review) don't. A pull request that conflicts with `main` (often because another one was
merged first) goes back to an agent: the worker restarts the branch from `main` with the task's
changes re-applied, the conflicting files keep `<<<<<<<`/`>>>>>>>` markers, and the agent
resolves them and can't hand the work in until they're gone. The Hub checks pull requests every 30 seconds; `aso sync` checks now.

The token needs **Pull requests: read and write** as well as *Contents: read and write*. For
the console to show checks, also give it **Actions: read** and **Commit statuses: read** (a
fine-grained token can't have *Checks*, so the Hub reads GitHub Actions results through
*Actions*). Without them the checks show as unreadable, and approving asks you to merge
anyway. Set
`ASO_PULL_REQUESTS=0` to merge on the Hub instead. A project's page in the console says which
of the two it does, and why.

### QA screenshots

Tests can pass while a change looks wrong. A project can have QA take screenshots, so you see
the result next to the diff:

1. **Add a `screenshots` npm script.** After the tests pass, for a change that lists views (see
   2), the QA worker runs `npm run screenshots` with `ASO_SCREENSHOT_DIR` set to an empty folder. The script saves images there,
   e.g. a Playwright spec that calls `page.screenshot({ path: path.join(process.env.ASO_SCREENSHOT_DIR, "home-dark.png") })`.
2. **Shots of the change.** A developer agent whose change shows in the UI lists the views that
   show it when it finishes, e.g. `{"name": "task-dark-phone", "path": "/tasks/t-1", "theme":
   "dark", "width": 412}`. QA passes the list as JSON in `ASO_SCREENSHOT_TARGETS`, and the script
   saves each as `<name>.png`. The fields are `name`, `path`, and optional `theme` (`light` or
   `dark`), `width`, `height`, `selector` (shoot one element) and `state` (the project's own name
   for the data a page needs, e.g. a mock scenario). A change that lists no views (a server route,
   a test, a library function) gets no screenshots, so a pull request never shows pictures that
   have nothing to do with it. Neither does an API sync task (`sync-hub-api-…`), whatever views
   its agent lists: it only regenerates types. Run by hand without the variable, the script takes its default
   views. The shots come from the tested commit, not from the agent. The Architect plans
   a screenshots script for a project with a UI that has none.
3. **Limits.** QA keeps up to 12 PNG, JPEG, GIF or WebP files from the top of that folder, in
   name order: up to 2 MB each and 4 MB together. Names may use letters, digits and `._-`.
   The QA summary says what was left out and why, and names the listed views the script did not
   save (its output, with the reasons, is in the QA worker's log).
4. **Never a failure.** A screenshots script that fails or times out (5 minutes) is noted in
   the QA summary; the tests passed, so QA still passes.
5. **Where to see them.** The task's page in the console has a **Screenshots** tab. The pull
   request lists them and, with `--console-url`, links to that page; GitHub can't show the images
   themselves, because they stay on the Hub (`GET /api/tasks/{id}/screenshots/{name}`).
6. **One set per task.** A later passing QA run replaces them. A run that takes none removes them,
   because they would show an older commit.

### Pushing main

If the target repository has an `origin` remote, the Hub pushes `main` to it after every
merge. A burst of merges becomes one push. Each merged task's history notes the push (or its
failure), and so do the dashboard and `aso sync`.

| Situation | What the Hub does |
|---|---|
| Push succeeds | Done; status `idle` with the last pushed commit |
| Someone pushed to GitHub's `main` meanwhile | Merges `origin/main` into `main` (merge commit) and pushes again |
| A pull request merged by hand on GitHub, or any push to its `main` | The Hub catches up within 2 minutes, and before the Architect plans or a plan is approved, so planning and new tasks start from it. The project then deploys it, as after any merge |
| That merge conflicts | Stops pushing (status `conflict`) and leaves both sides untouched. Resolve it in the Hub's checkout, then run `aso sync` |
| Network/auth error | Retries every 5 minutes and after the next merge; `aso sync` retries now |
| No `origin` remote, or `--no-push` | Merges stay local |

**Credentials:**

- **Native Hub:** pushes use your normal git setup (SSH agent, credential helper).
- **Hub in Docker, HTTPS remote:** put a GitHub **fine-grained token**, limited to that
  repository with *Contents: read and write*, in `ASO_GIT_TOKEN` (e.g. in the `.env`). It's
  sent only to the remote's host, as a header, and never written to `.git/config`.
- **Hub in Docker, SSH remote:** the container has no SSH keys. Use an HTTPS remote with a
  token, or run the Hub natively.
- **Pull requests:** opening them always needs `ASO_GIT_TOKEN`, also for a native Hub, since
  they go through GitHub's API. Add *Pull requests: read and write* to the token.
- **Branch protection:** if GitHub's `main` requires pull requests, merging through pull
  requests works, but the Hub's own pushes of `main` (after a dependency change) are rejected,
  and the error shows in `aso sync`.

## Deploying after a merge

The Hub can deploy a project each time work is merged into its `main`, so a merged change goes
live without anyone running a build. Give the project a command in `<projects root>/.aso/deploy.json`
on the Hub machine:

```json
{
  "aso-ui": {
    "command": "docker build -q -t aso-ui:$ASO_DEPLOY_SHORT . && docker rm -f aso-ui && docker run -d --name aso-ui --restart unless-stopped --network host -e PORT=7422 -e HOSTNAME=127.0.0.1 -e ASO_HUB_URL=http://127.0.0.1:7420 aso-ui:$ASO_DEPLOY_SHORT",
    "timeoutSec": 900
  }
}
```

- **When it runs.** After each merge into `main` (a pull request merged on GitHub or from
  the console, a merge on the Hub, or anything else that reached GitHub's `main`, picked up
  within 2 minutes), and on `POST /api/projects/<id>/deploy`. One deploy per project at a time;
  merges that land meanwhile are deployed together when it ends. A merge never deploys a commit
  that is already live; `POST /api/projects/<id>/deploy` does. The Hub remembers what is live
  (`<projects root>/.aso/deployed.json`), so when it starts it deploys what was merged while it
  was down, or a deploy a restart cut off, and nothing else.
- **Where it runs.** On the Hub machine, with `sh -c`, in a clean export of `main` at the merged
  commit (`<projects root>/.aso/deploy/<id>/`, no `.git`). With `aso start-hub --docker`, the
  container has no Docker or host tools, so the `aso start-hub` process on the host runs the
  command: it takes jobs from the Hub (`GET /api/deploys/next`) and reports the result back. `ASO_DEPLOY_PROJECT`,
  `ASO_DEPLOY_COMMIT` and `ASO_DEPLOY_SHORT` (7 characters) say what it is deploying.
- **What it sees.** Only a few variables of the Hub's environment (`PATH`, `HOME`, `USER`,
  locale, `TMPDIR`, `XDG_RUNTIME_DIR`, `DOCKER_HOST`, `DOCKER_CONFIG`) plus the entry's own
  `env`. The Hub's GitHub and Anthropic tokens are not passed on.
- **Limits.** `timeoutSec` 10–3600, default 900; on timeout the command and its children
  are stopped.
- **Results.** Your phone gets *"aso-ui: deployed"* or *"aso-ui: deploy failed"* with the last
  lines of output. `GET /api/projects/<id>` shows the latest deploy under `deploy.last`, and
  `<projects root>/.aso/deploy/<id>.log` has the end of its output. When the command itself
  fails (exits non-zero, `deploy.last.exitCode`), the task merged as that commit counts against
  the acceptance check that passed it; see
  [When a reviewer's "met" proves wrong](models.md#when-a-reviewers-met-proves-wrong).
- **Edits apply at once.** The file is read on every deploy; no Hub restart needed. Without
  an entry, a project doesn't deploy.
