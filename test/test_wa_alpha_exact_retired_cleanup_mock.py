#!/usr/bin/env python3
"""Offline synthetic regression for guarded Alpha stale-credential cleanup."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/wa-alpha-exact-retired-cleanup.py"
spec = importlib.util.spec_from_file_location("wa_alpha_exact_cleanup", SOURCE)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class ExactCleanupMock(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)

        def f(path, content="synthetic"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            os.chmod(path, 0o600)
            return path

        m = operator
        m.ROOT = base / "release-root"
        m.RELEASE = m.ROOT / "releases" / "ed0af597f525ce2295593d352530665ab4b38674"
        m.BASE_UNIT = f(base / "units" / "alpha-realtime-production-readonly.service")
        m.UNIT_DIR = base / "units" / "alpha-realtime-production-readonly.service.d"
        m.DUAL = f(m.UNIT_DIR / "60-wavealpha-api-next.conf")
        m.PRIMARY = f(m.UNIT_DIR / "zzzz-wa-alpha-read-key-primary.conf")
        m.NEXT = f(base / "encrypted" / "PRODUCTION_READ_API_SECRET_KEY_NEXT")
        m.ACTIVE = f(base / "encrypted" / "PRODUCTION_READ_API_SECRET_KEY_WA20261024")
        m.OLD = f(base / "runtime-source" / "PRODUCTION_READ_API_SECRET_KEY", "b" * 64)
        m.RUNTIME = base / "runtime-credentials"
        names = ("R2_READ_ONLY_ACCESS_KEY_ID", "R2_READ_ONLY_SECRET_ACCESS_KEY",
                 "SUPABASE_ANON_KEY", "ALPHA_LIVE_PUBLISH_KEY")
        m.PLAIN = {name: str(f(base / "runtime-source" / name)) for name in names}
        m.ENCRYPTED = {"PRODUCTION_READ_API_SECRET_KEY": str(m.ACTIVE)}
        f(m.RUNTIME / "PRODUCTION_READ_API_SECRET_KEY", "a" * 64)
        for n in names:
            f(m.RUNTIME / n)
        m.PHASE = "PREFLIGHT"
        m.MUTATED = False
        self.host = m.HOST
        self.shadow_source = "[Service]\nLoadCredential=ALPHA_LIVE_PUBLISH_KEY:protected\n"
        self.bad_after_reload = False
        self.commands = []
        self.reloaded = False

        def cmd(*args, timeout=12):
            self.commands.append(args)
            if args[:2] == ("hostname", "-s"):
                return self.host
            if args[:2] == ("readlink", "-f"):
                return str(m.RELEASE)
            if args[:2] == ("systemctl", "is-active"):
                return "active"
            if args[:3] == ("systemctl", "show", "-P"):
                return {"User": "wavealpha-alpha", "Restart": "no",
                        "NeedDaemonReload": "no", "MainPID": "12345"}[args[3]]
            if args[:2] == ("systemctl", "cat"):
                if args[-1] == m.SHADOW:
                    return self.shadow_source
                lines = ["[Service]", "LoadCredential=PRODUCTION_READ_API_SECRET_KEY:" + str(m.OLD)]
                if m.DUAL.exists():
                    lines.append("LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY_NEXT:" + str(m.NEXT))
                lines += ["LoadCredential="] + [
                    "LoadCredential=" + name + ":" + path for name, path in m.PLAIN.items()
                ]
                if not (self.bad_after_reload and self.reloaded):
                    lines.append("LoadCredentialEncrypted=PRODUCTION_READ_API_SECRET_KEY:" + str(m.ACTIVE))
                return "\n".join(lines)
            if args[:2] == ("systemctl", "daemon-reload"):
                self.reloaded = True
                return ""
            raise AssertionError(args)

        def http(key=None):
            return (200, b"{}") if key == "a" * 64 else (401, b"")

        for p in (patch.object(m, "run", side_effect=cmd),
                  patch.object(m, "http_status", side_effect=http),
                  patch.object(m.os, "geteuid", return_value=0)):
            p.start()
            self.addCleanup(p.stop)

    def execute(self):
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            result = operator.main()
        self.assertNotIn("a" * 64, log.getvalue())
        self.assertNotIn("b" * 64, log.getvalue())
        self.assertFalse(any("restart" in arg for args in self.commands for arg in args))
        return result, log.getvalue()

    def test_success_three_exact_removals(self):
        rc, log = self.execute()
        self.assertEqual(rc, 0, log)
        self.assertFalse(any(p.exists() for p in (operator.DUAL, operator.NEXT, operator.OLD)))
        self.assertTrue(all(p.exists() for p in (operator.ACTIVE, operator.PRIMARY)))
        self.assertTrue(all(Path(p).exists() for p in operator.PLAIN.values()))
        self.assertEqual(sum(args[:2] == ("systemctl", "daemon-reload") for args in self.commands), 1)

    def test_wrong_host_fail_closed(self):
        self.host = "wrong-vm"
        rc, log = self.execute()
        self.assertEqual(rc, 20, log)
        self.assertIn("MUTATION=NONE", log)
        self.assertTrue(all(p.exists() for p in (operator.DUAL, operator.NEXT, operator.OLD)))

    def test_shadow_consumer_blocks(self):
        self.shadow_source = "LoadCredential=PRODUCTION_READ_API_SECRET_KEY:" + str(operator.OLD)
        rc, log = self.execute()
        self.assertEqual(rc, 20, log)
        self.assertIn("SHADOW_OLD_API_SOURCE_REFERENCE", log)
        self.assertTrue(all(p.exists() for p in (operator.DUAL, operator.NEXT, operator.OLD)))

    def test_post_reload_drift_holds_partial(self):
        self.bad_after_reload = True
        rc, log = self.execute()
        self.assertEqual(rc, 21, log)
        self.assertIn("PARTIAL_CHECK_PATHS_NO_BLIND_RETRY", log)
        self.assertFalse(operator.DUAL.exists())
        self.assertTrue(operator.NEXT.exists() and operator.OLD.exists() and operator.ACTIVE.exists())

    def test_symlink_credential_blocks(self):
        operator.NEXT.unlink()
        operator.NEXT.symlink_to(operator.ACTIVE)
        rc, log = self.execute()
        self.assertEqual(rc, 20, log)
        self.assertTrue(operator.DUAL.exists() and operator.OLD.exists() and operator.ACTIVE.exists())


if __name__ == "__main__":
    unittest.main()
