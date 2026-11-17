"""Tests for the login expiry in quota-server.py. Run: python3 -m unittest test_quota_server"""
import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("quota_server", os.path.join(os.path.dirname(__file__), "quota-server.py"))
qs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qs)

DAY = 86400
NOW = 1_800_000_000


class LoginRecord(unittest.TestCase):
    def test_new_account_is_estimated_from_file_creation(self):
        rec = qs.login_record(None, NOW - 10 * DAY, dead=False, alive=True, now=NOW)
        self.assertEqual(rec, {"expires_at": NOW + 18 * DAY, "exact": False, "dead": False})

    def test_exact_record_is_kept(self):
        rec = {"expires_at": NOW + 5 * DAY, "exact": True, "dead": False}
        self.assertEqual(qs.login_record(rec, 0, dead=False, alive=True, now=NOW), rec)

    def test_dead_account_that_works_again_was_logged_in_now(self):
        rec = {"expires_at": NOW - DAY, "exact": True, "dead": True}
        self.assertEqual(
            qs.login_record(rec, 0, dead=False, alive=True, now=NOW),
            {"expires_at": NOW + 28 * DAY, "exact": False, "dead": False},
        )

    def test_dead_account_stays_dead_until_it_works(self):
        rec = {"expires_at": NOW - DAY, "exact": True, "dead": True}
        self.assertEqual(qs.login_record(rec, 0, dead=False, alive=False, now=NOW), rec)

    def test_access_token_outliving_the_refresh_token_is_not_a_login(self):
        rec = {"expires_at": NOW - 3600, "exact": True, "dead": False}
        self.assertEqual(qs.login_record(rec, 0, dead=False, alive=True, now=NOW), rec)

    def test_working_long_after_expiry_means_an_unseen_login(self):
        rec = {"expires_at": NOW - 2 * DAY, "exact": True, "dead": False}
        self.assertEqual(
            qs.login_record(rec, 0, dead=False, alive=True, now=NOW),
            {"expires_at": NOW + 28 * DAY, "exact": False, "dead": False},
        )


class Account(unittest.TestCase):
    def run_account(self, rec, windows, now=NOW):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "claude-a@b.c.json")
            with open(path, "w") as f:
                f.write('{"type": "claude", "email": "a@b.c", "access_token": "x"}')
            with mock.patch.object(qs, "usage", return_value=(windows, None)), mock.patch.object(qs, "created_at", return_value=now):
                return qs.account(path, {"claude-a@b.c.json": {"status": "active"}}, {"claude-a@b.c.json": rec} if rec else {}, now)

    def test_expiring_within_three_days_is_flagged(self):
        entry, rec = self.run_account({"expires_at": NOW + 2 * DAY, "exact": True, "dead": False}, [])
        self.assertEqual(entry["health"], "expires soon")
        self.assertEqual(rec["expires_at"], NOW + 2 * DAY)

    def test_expiry_outranks_a_full_window(self):
        entry, _ = self.run_account({"expires_at": NOW + DAY, "exact": True, "dead": False}, [{"name": "weekly", "used": 100.0, "resets_at": None}])
        self.assertEqual(entry["health"], "expires soon")

    def test_far_expiry_is_ok(self):
        entry, _ = self.run_account(None, [])
        self.assertEqual((entry["health"], entry["login_expires_at"], entry["login_expires_exact"]), ("ok", NOW + 28 * DAY, False))


class Text(unittest.TestCase):
    def render(self, **account):
        base = {"provider": "claude", "email": "a@b.c", "plan": None, "windows": [], "health": "ok", "detail": None}
        with mock.patch.object(qs.time, "time", return_value=NOW):
            return qs.as_text({"server": "s", "fetched_at": NOW, "proxy_state": True, "accounts": [{**base, **account}]})

    def test_estimate_has_a_tilde(self):
        self.assertIn("login         expires in ~5d 0h", self.render(login_expires_at=NOW + 5 * DAY, login_expires_exact=False))

    def test_exact_has_none(self):
        self.assertIn("login         expires in 5d 0h", self.render(login_expires_at=NOW + 5 * DAY, login_expires_exact=True))

    def test_past_expiry_asks_for_a_login(self):
        self.assertIn("expired, log in again", self.render(login_expires_at=NOW - 60, login_expires_exact=True, health="expires soon"))

    def test_dead_account_has_no_login_line(self):
        self.assertNotIn("login ", self.render(login_expires_at=NOW + DAY, login_expires_exact=False, health="dead", detail="log in again"))


class LoggedIn(unittest.TestCase):
    def test_records_exact_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "claude-a@b.c.json"), "w").close()
            with mock.patch.object(qs, "AUTH_DIR", d), mock.patch.object(qs, "LOGINS", os.path.join(d, "logins.json")):
                with contextlib.redirect_stdout(io.StringIO()):
                    qs.logged_in(["a@b.c", str(NOW)])
                with qs.Logins() as logins:
                    self.assertEqual(logins.data, {"claude-a@b.c.json": {"expires_at": NOW, "exact": True, "dead": False}})

    def test_unknown_account_is_refused(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(qs, "AUTH_DIR", d):
            with self.assertRaises(SystemExit):
                qs.logged_in(["nobody@x.y"])


class Contribute(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        qs._pending.clear()
        self.calls = []
        for patch in (mock.patch.object(qs, "AUTH_DIR", self.dir.name), mock.patch.object(qs, "LOGINS", os.path.join(self.dir.name, "logins.json"))):
            patch.start()
            self.addCleanup(patch.stop)

    def fake_mgmt(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path.startswith("/anthropic-auth-url"):
            return 200, {"status": "ok", "state": "st1", "url": "https://claude.ai/oauth/authorize?state=st1"}
        if path == "/oauth-callback":
            # The proxy writes the account's auth file once it has the tokens.
            with open(os.path.join(self.dir.name, "claude-new@x.y.json"), "w") as f:
                f.write('{"type": "claude", "email": "new@x.y"}')
            return 200, {"status": "ok"}
        if path.startswith("/get-auth-status"):
            return 200, {"status": "ok"}
        raise AssertionError(path)

    def test_start_then_finish_records_the_login(self):
        with mock.patch.object(qs, "mgmt", self.fake_mgmt), mock.patch.object(qs.time, "time", return_value=NOW):
            code, out = qs.contribute_start("claude")
            self.assertEqual((code, out["state"]), (200, "st1"))
            code, out = qs.contribute_finish("http://localhost:54545/callback?code=abc&state=st1")
        self.assertEqual(out, {"status": "ok", "provider": "claude", "accounts": ["new@x.y"]})
        self.assertIn(("POST", "/oauth-callback", {"provider": "anthropic", "redirect_url": "http://localhost:54545/callback?code=abc&state=st1", "state": "st1"}), self.calls)
        with qs.Logins() as logins:
            self.assertEqual(logins.data["claude-new@x.y.json"], {"expires_at": NOW + qs.LOGIN_LIFETIME, "exact": True, "dead": False})
        self.assertEqual(qs._pending, {})

    def test_finish_refuses_a_state_it_did_not_issue(self):
        with mock.patch.object(qs, "mgmt", self.fake_mgmt):
            code, _ = qs.contribute_finish("http://localhost:54545/callback?code=abc&state=forged")
        self.assertEqual(code, 400)
        self.assertEqual(self.calls, [])

    def test_unknown_provider_is_refused(self):
        self.assertEqual(qs.contribute_start("gemini")[0], 400)


if __name__ == "__main__":
    unittest.main()
