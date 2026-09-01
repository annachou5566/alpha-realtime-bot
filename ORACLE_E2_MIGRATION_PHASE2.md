# Oracle E2 Migration — Phase 2 Persistent Candidate

Status: **SOURCE PREP ONLY / NOT DEPLOYED / NOT PRODUCTION**

Phase 1 proved the exact qualification runtime on `micro-server-auto-2` with loopback-only bind, live Binance upstream access, R2/Supabase read-only access, zero observed mutation attempts in the bounded trial, and safe cleanup. Phase 2 prepares a persistent candidate layout without authorizing a Production cutover.

## Phase 2A target

Persist only the runtime artifacts needed to make repeated qualification deterministic:

- official Node 22 runtime under `/opt/wave-alpha/node/`;
- immutable release directory under `/opt/wave-alpha/alpha-realtime/releases/<sha>/`;
- `current` symlink to the approved release;
- dedicated non-login service user `wavealpha-alpha`;
- hardened systemd unit `alpha-realtime-qualification.service`;
- qualification credentials materialized only into `/run/wave-alpha-alpha/credentials/` (tmpfs) for the active qualification session.

The service remains **disabled by default**. Starting it is a separately approved Oracle mutation.

## Hard safety boundaries

Phase 2A must remain qualification-only:

- run only `oracle-qualification.js`;
- bind only `127.0.0.1:3100`;
- use bucket-scoped R2 Object Read-only credentials;
- use Supabase anon key, never service-role key;
- use a qualification-only API key;
- keep `ENABLE_TICK_CACHE=false` and canonical publishing off;
- no historical Binance scrape, start-offset scan, price backfill, finalize, auto-finalize, R2 write, or Supabase mutation;
- no Cloudflare Tunnel/DNS/route;
- no Production traffic;
- no Render resume/stop/change;
- no merge or mutation of `main`;
- no Production writer credentials;
- no service enable-on-boot in this phase.

## Secret handling

Qualification secrets must not be committed, logged, pasted into chat, or stored in the release tree. For Phase 2A they are injected into `/run/wave-alpha-alpha/credentials/`, which is tmpfs and disappears on reboot. The systemd unit consumes them through `LoadCredential=`.

Production credential storage is a later security gate. OCI Vault is preferred for that gate; Oracle documents Always Free support for Vault secrets, but tenancy headroom and exact IAM/Vault design must be verified before any mutation.

## Proposed Phase 2A mutation scope — requires explicit owner approval

Only after approval for this exact operation:

1. verify candidate identity is `micro-server-auto-2`, shape `VM.Standard.E2.1.Micro`;
2. verify current memory/disk/listeners and collision-free service paths;
3. install the already-qualified official Node 22 runtime under `/opt` without apt/global package mutation;
4. stage exact approved source head with `npm ci --ignore-scripts`;
5. create `wavealpha-alpha` non-login user and root-owned release directories;
6. install launcher + systemd unit, but leave it disabled;
7. create a fresh bucket-scoped R2 Object Read-only credential and materialize it plus the Supabase anon/qualification API key only under `/run`;
8. start the qualification service manually;
9. verify loopback-only bind, auth, live market response, zero mutation attempts, RAM/CPU, and Binance egress;
10. stop service and remove `/run` credentials unless owner separately approves an extended qualification window.

## Acceptance gates

A Phase 2A PASS requires fresh evidence of all of the following:

- exact release SHA and lockfile installation PASS;
- `systemctl is-enabled alpha-realtime-qualification.service` is not enabled;
- service active only for the approved window;
- `127.0.0.1:3100` only, never wildcard/public bind;
- `/health` = 200;
- unauthenticated protected API = 401;
- qualification-authenticated market API = 200 with non-empty current data;
- Binance upstream succeeds without 403/418/429 in the bounded evidence window;
- R2/Supabase reads succeed;
- zero observed R2/Supabase mutation attempts;
- no historical scrape/start-offset/backfill/finalize path fires;
- memory remains safely below the 1 GB VM limit;
- no Production traffic, Tunnel, DNS, Render, or `main` change;
- credentials removed at closeout.

Phase 2A PASS is still **not Production PASS and not Security PASS**.

## Later gates — explicitly separate

- Phase 2B: persistent secret source / OCI Vault + instance authorization.
- Phase 3: Cloudflare Tunnel/private ingress qualification.
- Phase 4: single-writer Production credential handoff and Render→Oracle cutover.
- Phase 5: post-cutover observation, rollback proof, and retirement/cleanup decisions.
