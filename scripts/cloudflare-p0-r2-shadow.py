#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"
GRAPHQL = API + "/graphql"
WRANGLER = ["npx", "--yes", "wrangler@4.125.0"]
BUCKET = "wave-alpha-data"
SHADOW_KEY = "tails_cache.v2.candidate.json"
LIVE_KEY = "tails_cache.json"

CLASS_A = {
    "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject",
    "CompleteMultipartUpload", "CreateMultipartUpload",
    "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart",
    "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors",
    "PutBucketLifecycleConfiguration",
}
CLASS_B = {
    "HeadBucket", "HeadObject", "GetObject", "UsageSummary",
    "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
    "GetBucketLifecycleConfiguration",
}
FREE_OPS = {"DeleteObject", "DeleteBucket", "AbortMultipartUpload"}


def run_json(cmd, env=None):
    cp = subprocess.run(cmd, check=True, capture_output=True, text=True, env=env)
    return json.loads(cp.stdout)


def auth_context():
    run_json(WRANGLER + ["whoami", "--json"])
    auth = run_json(WRANGLER + ["auth", "token", "--json"])
    typ = auth.get("type")
    if typ in ("api_token", "oauth"):
        token = str(auth.get("token") or "")
        if not token:
            raise RuntimeError("wrangler-auth-token-empty")
        return {"type": typ, "headers": {"Authorization": f"Bearer {token}"}}
    if typ == "api_key":
        key = str(auth.get("key") or "")
        email = str(auth.get("email") or "")
        if not key or not email:
            raise RuntimeError("wrangler-api-key-incomplete")
        return {
            "type": typ,
            "headers": {"X-Auth-Key": key, "X-Auth-Email": email},
        }
    raise RuntimeError(f"wrangler-auth-type-unsupported:{typ}")


def api_request(auth, url, method="GET", payload=None):
    headers = dict(auth["headers"])
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body = r.read()
            return r.status, body, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def api_json(auth, url, method="GET", payload=None, expected=(200,)):
    status, body, headers = api_request(auth, url, method, payload)
    if status not in expected:
        raise RuntimeError(f"cloudflare-http:{status}:{url}")
    try:
        obj = json.loads(body or b"{}")
    except Exception as exc:
        raise RuntimeError(f"cloudflare-json:{url}") from exc
    return status, obj, headers


def find_account(auth):
    _, obj, _ = api_json(auth, API + "/accounts?per_page=50")
    if not obj.get("success"):
        raise RuntimeError("account-list-unsuccessful")
    matches = []
    for account in obj.get("result") or []:
        aid = account.get("id")
        if not aid:
            continue
        status, body, _ = api_request(
            auth, f"{API}/accounts/{aid}/r2/buckets/{BUCKET}"
        )
        if status != 200:
            continue
        info = json.loads(body or b"{}")
        result = info.get("result") or {}
        if info.get("success") and result.get("name") == BUCKET:
            matches.append((account, result))
    if len(matches) != 1:
        raise RuntimeError(f"account-bucket-match-count:{len(matches)}")
    return matches[0]


def previous_utc_date(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    return (now.date() - dt.timedelta(days=1)).isoformat()


def candidate_info(path):
    raw = path.read_bytes()
    data = json.loads(raw)
    if data.get("schema_version") != 2 or data.get("complete") is not True:
        raise RuntimeError("candidate-contract")
    expected = previous_utc_date()
    if data.get("boundary_date") != expected:
        raise RuntimeError(
            f"candidate-boundary:{data.get('boundary_date')}!=expected:{expected}"
        )
    return {
        "raw": raw,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
        "boundary": data["boundary_date"],
    }


def graphql(auth, query, variables):
    _, obj, _ = api_json(
        auth, GRAPHQL, method="POST",
        payload={"query": query, "variables": variables},
    )
    if obj.get("errors"):
        raise RuntimeError("graphql-errors:" + json.dumps(obj["errors"]))
    return obj["data"]["viewer"]["accounts"][0]


def operation_usage(auth, account_id):
    now = dt.datetime.now(dt.timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    q = """
    query R2Ops($accountTag: string!, $startDate: Time, $endDate: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $startDate, datetime_leq: $endDate }
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }
    """
    rows = graphql(auth, q, {
        "accountTag": account_id,
        "startDate": start.isoformat().replace("+00:00", "Z"),
        "endDate": now.isoformat().replace("+00:00", "Z"),
    })["r2OperationsAdaptiveGroups"]
    counts = {}
    for row in rows:
        action = str((row.get("dimensions") or {}).get("actionType") or "")
        counts[action] = counts.get(action, 0) + int(
            (row.get("sum") or {}).get("requests") or 0
        )
    unknown = sorted(
        action for action in counts
        if action and action not in CLASS_A | CLASS_B | FREE_OPS
    )
    if unknown:
        raise RuntimeError("unknown-r2-action-types:" + ",".join(unknown))
    class_a = sum(counts.get(x, 0) for x in CLASS_A)
    class_b = sum(counts.get(x, 0) for x in CLASS_B)
    free = sum(counts.get(x, 0) for x in FREE_OPS)
    return class_a, class_b, free, counts


def storage_bound(auth, account_id):
    now = dt.datetime.now(dt.timezone.utc)
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    q = """
    query R2Storage($accountTag: string!, $startDate: Time, $endDate: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2StorageAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $startDate, datetime_leq: $endDate }
            orderBy: [datetime_DESC]
          ) {
            max { objectCount uploadCount payloadSize metadataSize }
            dimensions { bucketName datetime }
          }
        }
      }
    }
    """
    rows = graphql(auth, q, {
        "accountTag": account_id,
        "startDate": start.isoformat().replace("+00:00", "Z"),
        "endDate": now.isoformat().replace("+00:00", "Z"),
    })["r2StorageAdaptiveGroups"]
    if len(rows) >= 10000:
        raise RuntimeError("storage-metrics-possible-truncation")
    per_bucket = {}
    for row in rows:
        dims = row.get("dimensions") or {}
        name = str(dims.get("bucketName") or "UNKNOWN")
        m = row.get("max") or {}
        size = int(m.get("payloadSize") or 0) + int(m.get("metadataSize") or 0)
        per_bucket[name] = max(per_bucket.get(name, 0), size)
    return sum(per_bucket.values()), per_bucket


def current_storage(auth, account_id):
    _, obj, _ = api_json(auth, f"{API}/accounts/{account_id}/r2/metrics")
    if not obj.get("success"):
        raise RuntimeError("r2-account-metrics-unsuccessful")
    standard = (obj.get("result") or {}).get("standard") or {}
    total = 0
    for state in ("published", "uploaded"):
        m = standard.get(state) or {}
        total += int(m.get("payloadSize") or 0) + int(m.get("metadataSize") or 0)
    return total


def get_object_status(auth, account_id, key):
    url = f"{API}/accounts/{account_id}/r2/buckets/{BUCKET}/objects/{key}"
    return api_request(auth, url)[0]


def list_exact_object(auth, account_id, key):
    qs = urllib.parse.urlencode({"prefix": key, "per_page": 100})
    _, obj, _ = api_json(
        auth,
        f"{API}/accounts/{account_id}/r2/buckets/{BUCKET}/objects?{qs}",
    )
    if not obj.get("success"):
        raise RuntimeError("r2-list-unsuccessful")
    exact = [x for x in obj.get("result") or [] if x.get("key") == key]
    if len(exact) > 1:
        raise RuntimeError(f"duplicate-object-metadata:{key}")
    if not exact:
        return None
    x = exact[0]
    return {
        "key": x.get("key"),
        "etag": x.get("etag"),
        "size": x.get("size"),
        "last_modified": x.get("last_modified"),
        "storage_class": x.get("storage_class"),
    }


def bucket_reverify(auth, account_id):
    _, obj, _ = api_json(
        auth, f"{API}/accounts/{account_id}/r2/buckets/{BUCKET}"
    )
    result = obj.get("result") or {}
    if not obj.get("success") or result.get("name") != BUCKET:
        raise RuntimeError("bucket-reverify")
    if result.get("storage_class") != "Standard":
        raise RuntimeError("bucket-storage-class-not-standard")
    return result


def cmd_preflight(args):
    auth = auth_context()
    if auth["type"] == "api_token":
        _, obj, _ = api_json(auth, API + "/user/tokens/verify")
        if not obj.get("success") or (obj.get("result") or {}).get("status") != "active":
            raise RuntimeError("api-token-verify")
        print("TOKEN_VERIFY=PASS type=api_token")
    else:
        print(f"TOKEN_VERIFY=PASS type={auth['type']} via_wrangler_whoami")

    account, bucket = find_account(auth)
    aid = account["id"]
    if bucket.get("storage_class") != "Standard":
        raise RuntimeError("bucket-storage-class-not-standard")
    print("ACCOUNT_BUCKET_MATCH_GATE=PASS")
    print("ACCOUNT_ID=" + aid)
    print("ACCOUNT_NAME=" + str(account.get("name") or "UNKNOWN"))
    print("BUCKET=" + BUCKET)
    print("STORAGE_CLASS=Standard")

    info = candidate_info(args.candidate)
    class_a, class_b, free_ops, _ = operation_usage(auth, aid)
    month_bound, _ = storage_bound(auth, aid)
    current = current_storage(auth, aid)

    print(f"R2_MONTH_CLASS_A={class_a}")
    print(f"R2_MONTH_CLASS_B={class_b}")
    print(f"R2_MONTH_FREE_OPS={free_ops}")
    print(f"R2_MONTH_STORAGE_CONSERVATIVE_BYTES={month_bound}")
    print(f"R2_CURRENT_STANDARD_STORAGE_BYTES={current}")
    print(f"CANDIDATE_BYTES={info['bytes']}")

    if class_a + 2 >= 900_000:
        raise RuntimeError("free-class-a-headroom")
    if class_b + 4 >= 9_000_000:
        raise RuntimeError("free-class-b-headroom")
    if month_bound + info["bytes"] >= 9_000_000_000:
        raise RuntimeError("free-month-storage-headroom")
    if current + info["bytes"] >= 9_000_000_000:
        raise RuntimeError("free-current-storage-headroom")

    print("FREE_CLASS_A_GATE=PASS")
    print("FREE_CLASS_B_GATE=PASS")
    print("FREE_STORAGE_GATE=PASS")

    if get_object_status(auth, aid, SHADOW_KEY) != 404:
        raise RuntimeError("shadow-key-not-absent")
    print("SHADOW_KEY_ABSENCE=PASS")

    live = list_exact_object(auth, aid, LIVE_KEY)
    if live is None:
        raise RuntimeError("live-key-metadata-missing")
    print("LIVE_KEY_METADATA_GATE=PASS")
    print("LIVE_KEY_ETAG_BEFORE=" + str(live.get("etag") or ""))
    print("LIVE_KEY_SIZE_BEFORE=" + str(live.get("size") or ""))

    receipt = {
        "account_id": aid,
        "account_name": account.get("name"),
        "bucket": BUCKET,
        "shadow_key": SHADOW_KEY,
        "live_key": LIVE_KEY,
        "candidate_sha256": info["sha256"],
        "candidate_bytes": info["bytes"],
        "boundary_date": info["boundary"],
        "class_a": class_a,
        "class_b": class_b,
        "month_storage_bound": month_bound,
        "current_storage": current,
        "live_before": live,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    args.gate.write_text(json.dumps(receipt, separators=(",", ":")))
    os.chmod(args.gate, 0o600)
    print("CANDIDATE_BOUNDARY_GATE=PASS")
    print("CANDIDATE_SHA256=" + info["sha256"])
    print("CLOUDFLARE_PREFLIGHT=PASS")
    print("MUTATION_EXECUTED=NO")


def wrangler_env(account_id):
    env = os.environ.copy()
    env["CLOUDFLARE_ACCOUNT_ID"] = account_id
    return env


def rollback_shadow(account_id):
    env = wrangler_env(account_id)
    subprocess.run(
        WRANGLER + [
            "r2", "object", "delete", f"{BUCKET}/{SHADOW_KEY}",
            "--remote", "--force",
        ],
        env=env,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def cmd_write(args):
    gate = json.loads(args.gate.read_text())
    created = dt.datetime.fromisoformat(gate["created_at"])
    now = dt.datetime.now(dt.timezone.utc)
    if now - created > dt.timedelta(minutes=15):
        raise RuntimeError("preflight-stale")

    auth = auth_context()
    account, _ = find_account(auth)
    aid = account["id"]
    if aid != gate["account_id"]:
        raise RuntimeError("account-drift")
    bucket_reverify(auth, aid)

    info = candidate_info(args.candidate)
    if (
        info["sha256"] != gate["candidate_sha256"]
        or info["bytes"] != gate["candidate_bytes"]
        or info["boundary"] != gate["boundary_date"]
    ):
        raise RuntimeError("candidate-drift")

    if get_object_status(auth, aid, SHADOW_KEY) != 404:
        raise RuntimeError("shadow-key-not-absent-on-write")

    live_before = list_exact_object(auth, aid, LIVE_KEY)
    if live_before != gate["live_before"]:
        raise RuntimeError("live-key-metadata-drift-before-write")

    env = wrangler_env(aid)
    print("WRITE_TARGET_GATE=PASS")
    subprocess.run(
        WRANGLER + [
            "r2", "object", "put", f"{BUCKET}/{SHADOW_KEY}",
            "--remote", "--force",
            "--storage-class", "Standard",
            "--content-type", "application/json",
            "--file", str(args.candidate),
        ],
        env=env,
        check=True,
    )
    print("R2_SHADOW_PUT=PASS")

    verify = pathlib.Path(tempfile.mkstemp(prefix="wa-r2-shadow-", suffix=".json")[1])
    try:
        subprocess.run(
            WRANGLER + [
                "r2", "object", "get", f"{BUCKET}/{SHADOW_KEY}",
                "--remote", "--file", str(verify),
            ],
            env=env,
            check=True,
        )
        downloaded = verify.read_bytes()
        remote_sha = hashlib.sha256(downloaded).hexdigest()
        if len(downloaded) != info["bytes"] or remote_sha != info["sha256"]:
            rollback_shadow(aid)
            raise RuntimeError("shadow-read-after-write-hash")
        payload = json.loads(downloaded)
        if (
            payload.get("schema_version") != 2
            or payload.get("complete") is not True
            or payload.get("boundary_date") != info["boundary"]
        ):
            rollback_shadow(aid)
            raise RuntimeError("shadow-read-after-write-contract")
    finally:
        verify.unlink(missing_ok=True)

    shadow_meta = list_exact_object(auth, aid, SHADOW_KEY)
    if shadow_meta is None or int(shadow_meta.get("size") or -1) != info["bytes"]:
        rollback_shadow(aid)
        raise RuntimeError("shadow-metadata-postcondition")

    live_after = list_exact_object(auth, aid, LIVE_KEY)
    if live_after != gate["live_before"]:
        rollback_shadow(aid)
        raise RuntimeError("live-key-metadata-changed")

    receipt = {
        "account_id": aid,
        "bucket": BUCKET,
        "key": SHADOW_KEY,
        "boundary_date": info["boundary"],
        "bytes": info["bytes"],
        "sha256": info["sha256"],
        "shadow_metadata": shadow_meta,
        "live_before": gate["live_before"],
        "live_after": live_after,
        "verified_at": now.isoformat(),
        "live_key_mutated": False,
    }
    args.receipt.write_text(json.dumps(receipt, separators=(",", ":")))
    os.chmod(args.receipt, 0o600)

    print("R2_SHADOW_GET_VERIFY=PASS")
    print("R2_SHADOW_HASH_VERIFY=PASS")
    print("R2_SHADOW_CONTRACT_VERIFY=PASS")
    print("LIVE_KEY_METADATA_UNCHANGED=PASS")
    print("R2_SHADOW_BYTES=" + str(info["bytes"]))
    print("R2_SHADOW_SHA256=" + info["sha256"])
    print("LIVE_TAILS_CACHE_MUTATED=NO")
    print("R2_SHADOW_WRITE=PASS")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=("preflight", "write"))
    p.add_argument("--candidate", type=pathlib.Path, required=True)
    p.add_argument("--gate", type=pathlib.Path, required=True)
    p.add_argument("--receipt", type=pathlib.Path, default=pathlib.Path("/tmp/wa-phase-d-r2-shadow-receipt.json"))
    args = p.parse_args()
    if not args.candidate.is_file():
        raise RuntimeError("candidate-missing")
    print("=== CLOUDFLARE_P0_R2_SHADOW_" + args.mode.upper() + "_BEGIN ===")
    if args.mode == "preflight":
        cmd_preflight(args)
    else:
        cmd_write(args)
    print("SECRET_VALUES_PRINTED=NO")
    print("=== CLOUDFLARE_P0_R2_SHADOW_" + args.mode.upper() + "_END ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("PHASE_D_CLOUDFLARE_ERROR=" + str(exc), file=sys.stderr)
        raise SystemExit(1)
