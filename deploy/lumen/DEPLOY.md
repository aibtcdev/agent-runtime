# Lumen Proving Deploy

This is the first live proving deployment for Lumen.

The deployment rule is strict:

- install `agent-runtime` beside the current Hermes tree
- do not mutate `~/.hermes/hermes-agent`
- keep Lumen's scope narrow: GitHub story summaries and Discord interactions only

## Target Host

- host: `dev@192.168.1.16`
- working tree suggestion: `/home/dev/agent-runtime`
- config: `/home/dev/agent-runtime/deploy/lumen/runtime.lumen.json`
- optional host override: `/home/dev/agent-runtime/deploy/lumen/runtime.lumen.host.json`
- recommended persistent host override: `/home/dev/.config/agent-runtime/lumen.host.json`

## Provisioning Steps

1. Copy `agent-runtime/` to `/home/dev/agent-runtime`.
2. Create the Lumen state directories:
   - `/home/dev/agent-runtime/deploy/lumen/state`
   - `/home/dev/agent-runtime/deploy/lumen/state/logs`
   - `/home/dev/agent-runtime/deploy/lumen/state/artifacts`
3. Install Bun for the `dev` user if it is missing:

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
~/.bun/bin/bun --version
```

4. Run:
   - `cd /home/dev/agent-runtime`
   - `~/.bun/bin/bun install`
   - `bunx tsc --noEmit`
   - `bun test`
   - `mkdir -p ~/.config/agent-runtime`
   - copy `deploy/lumen/runtime.lumen.host.example.json` to `~/.config/agent-runtime/lumen.host.json` if you want host-local Claude/Hermes adapter wiring
   - change its `extends` value to `/home/dev/agent-runtime/deploy/lumen/runtime.lumen.json`
   - edit `~/.config/agent-runtime/lumen.host.json` with the host's real adapter commands and env/settings paths
   - `bun run src/cli.ts healthcheck --config ~/.config/agent-runtime/lumen.host.json` when using the override, otherwise keep using `deploy/lumen/runtime.lumen.json`

## First Manual Bring-Up

Before enabling any timer:

1. Queue one known-safe GitHub story task:

```bash
cd /home/dev/agent-runtime
bun run src/cli.ts bridge-github --file fixtures/github-pr-merged.json --config deploy/lumen/runtime.lumen.json
```

2. Run one manual cycle:

```bash
bun run src/cli.ts run-once --config deploy/lumen/runtime.lumen.json
```

3. Inspect:

```bash
bun run src/cli.ts status --config deploy/lumen/runtime.lumen.json
tail -n 20 deploy/lumen/state/logs/runtime.jsonl
```

Expected result for the GitHub story smoke:

- task finishes as `completed`
- `operator_summary` is populated
- `file_changes` is `[]`
- `artifact_paths` is `[]`

GitHub-story tasks on Lumen are summary-only. Repository source paths must not be reported as managed artifacts.

Observed proving result on the isolated Lumen test tree:

- `healthcheck` passed
- GitHub bridge task `08d6bb42-fe1b-4f4d-b803-c913728e5c88` completed successfully
- `attempt_id = 4616b317-a356-44bc-a06c-d3d56165fc14`
- `bundle_hash = 00dd7af855474a75df3917e0849fb714f1afbacc595a8f372911fe3d271f2e7c`
- completed outcome recorded `file_changes: []` and `artifact_paths: []`

Observed on the real Lumen host on 2026-04-17:

- remote `~/.bun/bin/bunx tsc --noEmit` passed in `/home/dev/agent-runtime`
- remote `~/.bun/bin/bun test` passed in `/home/dev/agent-runtime` (`56` tests, `0` failures)
- remote `~/.bun/bin/bun run src/cli.ts healthcheck --config deploy/lumen/runtime.lumen.json` passed
- manual GitHub bridge task `d1e54585-262a-440c-8a11-420aee62f688` completed successfully
- `attempt_id = 00c6c2c4-332a-4021-b42b-ddb3c8b12802`
- `bundle_hash = 84cd3aba9e71c8481c5c773ac043629762111279a7788f297178a832e02e2a64`
- completed outcome recorded `file_changes: []` and `artifact_paths: []`
- operator UI was already enabled and reachable at `http://127.0.0.1:4314/`
- Hermes remained intact at `/home/dev/.hermes/hermes-agent`

Observed blocker on the real Lumen host on 2026-04-17:

- first manual Discord bridge task `d0fb098c-ff0c-497d-b5df-98929bc5ab5e` was claimed and then blocked by validation
- blocked `attempt_id = e069b711-efb6-4b76-b7ab-139705192504`
- validator rejected unmanaged `artifact_paths` and invented `file_changes` from the model output
- follow-on fix narrowed the `discord-reply` prompt contract so reply-only runs must keep `artifact_paths: []` and `file_changes: []` unless Lumen actually writes managed artifacts or edits files
- after re-syncing the fix, a fresh Discord bridge task `dd5f86a9-17d5-4ce2-ba70-201901a0de85` was queued, but the live queue was preempted by existing higher-priority workflow work from workflow `19`
- workflow `19` generated `goal-execute` task `7f37ca33-01c1-45a1-b9fb-e94afc6d5ba2`, which completed successfully
- workflow `19` then generated `goal-verify` task `94f8f927-738f-4bdc-b7d7-ee894a9d3763`, which eventually completed successfully with `attempt_id = 89b7361c-6874-4b5a-969d-e4e6a7526a85`
- a subsequent manual `run-once` still did not reach Discord because workflow `19` generated another higher-priority `goal-verify` task `356efd46-3500-4511-872c-9ab8b3b35391`
- latest running workflow-generated task at the last check:
  - `task_id = 356efd46-3500-4511-872c-9ab8b3b35391`
  - `attempt_id = 796e839d-d26a-43f2-a6e3-02fc615bbc66`
  - `bundle_hash = bfb207770fefd0b0143267e04c18b345c10e655013affc85ab6800cb2d6e03ed`
  - workflow `19` remained in `current_state = verify`
- the fresh Discord task `dd5f86a9-17d5-4ce2-ba70-201901a0de85` remained `pending` behind the repeated workflow-generated verify work

Exact resume point if this blocker persists:

1. Wait for or inspect workflow `19` (`instance_key = lumen-simplified-bounded-2026-04-12-05`) and its latest running task `356efd46-3500-4511-872c-9ab8b3b35391` / attempt `796e839d-d26a-43f2-a6e3-02fc615bbc66` on `/home/dev/agent-runtime/deploy/lumen/state/runtime.db`
2. Once it reaches a terminal state, run:
   - `cd /home/dev/agent-runtime`
   - `~/.bun/bin/bun run src/cli.ts run-once --config deploy/lumen/runtime.lumen.json`
3. If workflow `19` generates another higher-priority `goal-verify` task instead of draining, treat that workflow loop as the operational blocker and clear or complete workflow `19` before retrying Discord
4. Confirm fresh Discord task `dd5f86a9-17d5-4ce2-ba70-201901a0de85` completes successfully
5. Only then enable `agent-runtime-dispatch@lumen.timer` and verify one unattended timer-fired cycle

Only enable the timer after this manual cycle completes cleanly on the real config you intend to run, whether that is `deploy/lumen/runtime.lumen.json` or a host-local override such as `~/.config/agent-runtime/lumen.host.json`.

4. Queue one known-safe Discord reply task:

```bash
bun run src/cli.ts bridge-discord --file fixtures/discord-mention.json --config deploy/lumen/runtime.lumen.json
bun run src/cli.ts run-once --config deploy/lumen/runtime.lumen.json
```

5. After both manual bridge tasks succeed:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-operator@lumen.service
systemctl --user enable --now agent-runtime-dispatch@lumen.timer
systemctl --user status agent-runtime-operator@lumen.service
systemctl --user status agent-runtime-dispatch@lumen.timer
curl http://127.0.0.1:4314/api/state
```

6. Verify one unattended timer-fired cycle:

```bash
journalctl --user -u agent-runtime-run-once@lumen.service -n 50 --no-pager
tail -n 50 deploy/lumen/state/logs/runtime.jsonl
```

## Systemd Units

Install these files under `~/.config/systemd/user/`:

- `agent-runtime-run-once@.service`
- `agent-runtime-dispatch@.timer`
- `agent-runtime-operator@.service`

Template instance for Lumen:

- service instance name: `lumen`
- config path environment: `/home/dev/agent-runtime/deploy/lumen/runtime.lumen.json`

Enable the timer:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-dispatch@lumen.timer
systemctl --user status agent-runtime-dispatch@lumen.timer
```

Enable the operator UI separately:

```bash
systemctl --user daemon-reload
systemctl --user enable --now agent-runtime-operator@lumen.service
systemctl --user status agent-runtime-operator@lumen.service
curl http://127.0.0.1:4314/api/state
```

The LAN operator UI serves:

- static operator UI at `/`
- runtime status at `/api/state`
- heartbeat at `/api/heartbeat`
- workflow, task, event, artifact, snapshot, and snapshot-report reads under `/api/*`
- bounded operator task enqueue at `POST /api/tasks/queue`
- non-running task cancel at `POST /api/tasks/:task_id/cancel`
- dispatch pause read/set at `/api/pause`
- SSE updates at `/api/stream`

## Rollback

1. Stop the timer:
   - `systemctl --user stop agent-runtime-dispatch@lumen.timer`
2. Stop any in-flight service:
   - `systemctl --user stop agent-runtime-run-once@lumen.service`
   - `systemctl --user stop agent-runtime-operator@lumen.service`
3. Keep `deploy/lumen/state/logs/` for inspection.
4. Move the proving runtime out of the way or restore the previous tree.
5. Do not touch the existing Hermes service unless the proving runtime explicitly replaced it later.

## Exit Condition For “Lumen Is Fired Up”

Lumen counts as fired up when all of the following are true:

- `healthcheck` passes on the Lumen host
- one manual GitHub story task completes successfully
- one manual Discord reply task completes successfully
- GitHub-story completed outcomes remain summary-only (`file_changes: []`, `artifact_paths: []`) unless Lumen explicitly writes managed artifacts later
- timer is enabled and completes at least one unattended cycle without retry/backoff anomalies
- operator UI is reachable on `127.0.0.1:4314`
- current Hermes installation remains intact beside the proving runtime

## Final Bring-Up Update (2026-04-21)

Observed on the real Lumen host on 2026-04-21:

- workflow `19` (`lumen-simplified-bounded-2026-04-12-05`) was still marked active in `verify`, even though its repeated `goal-verify` work was historical proving-loop residue
- manually completed workflow `19` to stop it from starving the live queue
- pending real-host Discord bridge task `dd5f86a9-17d5-4ce2-ba70-201901a0de85` then ran cleanly
- Discord completion details:
  - `attempt_id = ad3b7849-b514-4718-b2d6-176e1a8924cb`
  - `bundle_hash = d02cc93a86377826122c8b0abcad35b842d65a88eee748d44264e7512ab00103`
  - completed outcome recorded `file_changes: []` and `artifact_paths: []`
- operator UI remained reachable at `http://127.0.0.1:4314/`
- enabled `agent-runtime-dispatch@lumen.timer`
- unattended timer-fired cycles were observed at `2026-04-21T22:10:10Z` and `2026-04-21T22:10:33Z`
- `agent-runtime-run-once@lumen.service` exited `0/SUCCESS` on those timer-fired runs with JSON result `{ "ok": true, "status": "idle" }`
- runtime log showed matching unattended events:
  - `2026-04-21T22:10:10.199Z` `workflow_evaluation` with `tasks_created: 0`
  - `2026-04-21T22:10:33.580Z` `workflow_evaluation` with `tasks_created: 0`
  - `/api/state` last event was `dispatch_idle`
- no retry/backoff anomalies were observed during the unattended timer-fired cycles
- Hermes remained intact beside the proving runtime at `/home/dev/.hermes/hermes-agent`

Exit condition status:

- `healthcheck` passes on the Lumen host: yes
- one manual GitHub story task completes successfully: yes
- one manual Discord reply task completes successfully: yes
- GitHub-story completed outcomes remain summary-only: yes
- timer is enabled and completed unattended cycles without retry/backoff anomalies: yes
- operator UI is reachable on `127.0.0.1:4314`: yes
- Hermes installation remains intact beside the proving runtime: yes

Result: the exit condition in this file is now satisfied. Lumen is fired up on the real proving host.
