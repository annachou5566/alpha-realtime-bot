# Oracle E2 Migration — Phase 3 Runtime Closeout

Status: **CLOSED / PASS**

Checkpoint: **2026-09-01**

This document records the actual Phase 3 runtime path. It supersedes the pre-execution Phase 3 public-hostname/Access assumptions where they differ from runtime evidence.

## Actual no-custom-domain architecture

Wave Alpha currently uses `wave-alpha.pages.dev` and does not yet have an owner-controlled custom domain. Phase 3 therefore qualified a domain-agnostic private backend path:

```text
qualification Worker on workers.dev
  -> Workers VPC Service Binding
  -> Workers VPC Service
  -> retained Cloudflare Tunnel
  -> Oracle loopback responder 127.0.0.1:3101
```

The important permanent invariant remains unchanged:

```text
Cloudflare Worker / Pages Function -> exchange API   FORBIDDEN
Oracle Alpha service -> exchange API                 ALLOWED after the relevant phase gate
```

Cloudflare remained downstream ingress/transport only. No exchange fetch was caused by Cloudflare during Phase 3.

## Retained identity

```text
Oracle VM:       micro-server-auto-2
Shape:           VM.Standard.E2.1.Micro
Region:          ap-singapore-1
Tunnel ID:       85317397-bd10-4a04-b980-ca344418ab74
Tunnel name:     wa-alpha-oracle-phase3-vpc-qual-2026-09-01
Tunnel config:   remotely managed / config_src=cloudflare
cloudflared:     2026.8.3
binary SHA-256:  f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e
```

The Tunnel object is intentionally retained dormant for later reviewed reuse. After cleanup its Cloudflare status is `down`, which is expected for a tunnel that connected successfully in the past but currently has no running connector.

## Runtime evidence

Connector qualification proved four registered QUIC connections to Cloudflare Singapore POPs. The secretless loopback responder returned exactly:

```json
{"ok":true,"service":"wa-alpha-phase3-qualification"}
```

The qualification VPC Service was first created with `hostname=localhost` / HTTP `3101`. End-to-end Worker -> VPC -> Tunnel -> Oracle succeeded, but cloudflared logs later proved intermittent IPv6 resolution to `[::1]:3101` while the responder listened only on `127.0.0.1:3101`.

The concrete invalidator was fixed by updating the same VPC Service to exact IPv4:

```text
127.0.0.1:3101
```

After that fix:

- bounded end-to-end trials: **5/5 HTTP 200** with the exact marker;
- earlier functional trials before the fix: **5/5 HTTP 200**, but their coexistence with IPv6 refusal logs is not treated as clean closeout evidence;
- additional CPU-trigger requests: **3/3 HTTP 200**;
- unknown path: **404**;
- wrong method POST `/health`: **405**.

Cloudflare Worker dashboard evidence for exact active qualification version `6ff6f5a0-d07f-4351-9fd7-13d9626bdee6` showed:

```text
Invocations:           14
Subrequests:           11
Errors:                0
CPU Time summary:      ~1 ms
Median CPU Time:       1.06 ms
Wall Time summary:     ~70 ms
Traffic to version:    100%
Client disconnects:    none in the selected window
```

CLI GraphQL/Observability CPU queries were unavailable under the current Wrangler OAuth permissions and were not misreported as zero. Dashboard metrics supplied the actual CPU evidence instead.

## Oracle resource evidence

Post-trial bounded evidence:

```text
load:                    0.00 0.00 0.00
RAM total:               954 MB
RAM available:           525 MB
root disk:               45 GB total / 8% used
cloudflared restarts:    0
responder restarts:      0
Alpha service:           inactive
port 3100:               none
port 3101 during test:   loopback only
```

No Alpha Production service, writer, Production credential, Render mutation, Pages Production mutation, DNS mutation, database mutation or storage mutation was authorized by this phase.

## Phase 3E cleanup

Cleanup completed in this order:

1. qualification Worker deleted;
2. qualification VPC Service deleted;
3. secretless responder stopped;
4. cloudflared connector stopped;
5. runtime Tunnel token removed from `/run`;
6. responder source/unit removed;
7. qualification cloudflared systemd unit removed.

Final control-plane/runtime state:

```text
qualification Worker:       absent (404)
VPC Services:               none
responder:                   absent/inactive
port 3101:                  none
cloudflared connector unit:  absent
runtime Tunnel token:        absent
Alpha service:               inactive
port 3100:                  none
Tunnel object:               retained, not deleted, status=down
cloudflared pinned binary:   retained
```

## Phase result

**Phase 3 CLOSED / PASS.**

This is private-ingress transport qualification only. It is not Alpha Production PASS and not Wave Alpha Production SECURITY PASS.

Approximate migration progress after this closeout: **~92%**.
