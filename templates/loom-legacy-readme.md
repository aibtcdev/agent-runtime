# arc-starter — Legacy Install (Paused)

This arc-starter installation was paused as part of RFC 0010 Phase 1 (Loom VM handover).

**Snapshot SHA:** {{SNAPSHOT_SHA}}  
**Paused at:** {{PAUSED_AT}}  
**Paused by:** RFC 0010 Phase 1 — Loom VM handover task

## What Replaced It

agent-runtime is now installed at `/home/dev/agent-runtime/` with the Loom deploy profile.

- Config: `/home/dev/agent-runtime/deploy/loom/runtime.loom.json`
- State: `/home/dev/agent-runtime/deploy/loom/state/`
- Profile: `deploy/loom/IDENTITY.md`

## Identity Continuity

Loom's on-chain addresses are preserved. No new wallets were created.

| Network | Address |
|---------|---------|
| Bitcoin (Taproot) | `bc1ptqmds7ghh5lqexzd34xnf5sryxzjvlvuj2eetmhgjkp998545tequsd9we` |
| Stacks | `SP1KGHF33817ZXW27CG50JXWC0Y6BNXAQ4E7YGAHM` |

## Disabled Services

The following systemd user timers/services were disabled:

- `arc-dispatch.timer`
- `arc-sensors.timer`
- `arc-web.service`
- `arc-watchdog.timer`

## Re-enable arc-starter (Rollback)

If agent-runtime needs to be reverted:

```bash
systemctl --user enable --now arc-dispatch.timer arc-sensors.timer arc-web.service
```

This repository remains intact at this path. No files were deleted.
