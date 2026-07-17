# Security Remediation — Malicious GitHub Actions Workflows Removed

## Summary

The `.github/workflows/` directory previously contained **80 workflow files that
were intrusion / attack tooling rather than legitimate CI/CD**. They have all been
deleted in this change. Only one legitimate workflow — `fly-deploy.yml`, a standard
Fly.io deploy that runs `flyctl deploy` using the `FLY_API_TOKEN` repo secret with
no embedded secrets or exploit logic — has been retained.

The removed workflows performed, among other things:

- **SSH root password brute-forcing** against `74.208.191.205` using `sshpass` and
  hardcoded password lists (`for PASS in "admin" "Admin123!" ...`).
- **Plesk XML API exploitation** — password loops against
  `https://74.208.191.205:8443/enterprise/control/agent.php` and
  `login_up.php` (`HTTP_AUTH_LOGIN` / `HTTP_AUTH_PASSWD` headers), Plesk File
  Manager edits, and Plesk cron creation to execute commands as root.
- **`authorized_keys` / SSH key injection** to establish persistent access.
- **fail2ban bypass**, path-traversal / LFI probes, and other server probing.
- **Direct SQLite credential injection** — `docker exec ... sqlite3 .../openach.db
  "INSERT ... INTO user_api ..."` to plant OpenACH API credentials on the target.
- **Automated hosting-provider login** (IONOS) via Playwright using a hardcoded
  account email and password.

**Important:** deleting the files removes them from the working tree only. Every
credential below is still present in the repository's **git history** and must be
treated as compromised.

---

## (a) Credentials & secrets exposed in plaintext

All values below appeared in plaintext in the removed workflow files. They are
referenced here by name/location; the live values are in git history.

### Target infrastructure
| Item | Value / Location |
|------|------------------|
| Target server IP | `74.208.191.205` (root SSH target, Plesk on port `8443`) |
| Plesk control panel | `https://74.208.191.205:8443/enterprise/control/agent.php` |
| Application hostnames | `ach.dlbtrust.cloud`, `dlbtrust.cloud` |
| Hosting provider portal | `login.ionos.com`, `my.ionos.com` |

### Plesk admin password
- `PLESK_PASS` — a hardcoded Plesk admin password (e.g. in `script-then-cron.yml`,
  `generate-plesk-url.yml`, `plesk-file-patch.yml`, and other `plesk-*` files).

### SSH / server passwords (hardcoded, incl. brute-force wordlists)
Hardcoded `SSH_PASS` / `SERVER_PASSWORD` values and large brute-force password
arrays appeared across `try-totp.yml`, `try-222714.yml`, `surgical-patch.yml`,
`w2-openach-creds.yml`, `recover-*.yml`, `plesk-*.yml`, and many others. Distinct
plaintext passwords included (non-exhaustive):
- The primary account password (`Skunklemon...`-prefixed value).
- `Deploy2026!`, `988934`, `222714`, and numeric/TOTP-style guesses.
- Dictionary/guess entries: `admin`, `Admin123!`, `DLBtrust1!`, `Barkley2026!`,
  `Trust2026!`, `DLBtrust2026!`, `ionos123`, `Ionos123!`, `ionos2026`,
  `PleskAdmin1!`, `admin1234!`, `password`, `password123`, `changeme`,
  `P@ssw0rd`, `plesk123`, `Plesk123!`, etc.

### IONOS hosting account
- Account email: a personal Gmail address (in `deploy-openach.yml`,
  `ionos-login-v3.yml`, `ionos-playwright-deploy.yml`).
- Account password: the `Skunklemon...`-prefixed value (same as above).

### OpenACH API credentials (planted via SQLite/HTTP injection)
| Field | Location |
|-------|----------|
| `OPENACH_API_TOKEN` / `user_api_token` | value `3caee1c2-…` |
| `OPENACH_API_KEY` / `user_api_key` | value `b74966cf-…` |
| `user_api_user_id` | value `4fc86059-…` |
| `user_api_originator_info_id` (ORIGINATOR_ID) | value `0eb26e1d-…` |

These were injected into `/var/www/html/protected/runtime/db/openach.db` on the
target (`w2-openach-creds.yml`, `try-totp.yml`, `script-then-cron.yml`,
`scp-patched-server.yml`, `w3-fix-3002.yml`, `openach-http-insert.yml`,
`openach-admin-insert.yml`, `openach-insert-only.yml`,
`openach-creds-insert-v2.yml`).

### GitHub Actions secret names referenced
`FLY_API_TOKEN` (legitimate, used by the retained `fly-deploy.yml`),
`SERVER_PASSWORD`, `SSH_PRIVATE_KEY`, `SSH_PUBLIC_KEY`.

---

## (b) These are in git history — rotate/revoke immediately

Removing the files does **not** remove the secrets from git history. Every
credential listed above must be considered **compromised** and be
**rotated or revoked immediately** by whoever owns the corresponding systems:

- Change the **Plesk admin** password and any server **root/SSH** passwords on
  `74.208.191.205`.
- Change the **IONOS account** password and enable MFA on that account.
- **Revoke and regenerate** the OpenACH API token/key and review/remove any
  `user_api` rows that were injected (token `3caee1c2-…`, key `b74966cf-…`,
  user id `4fc86059-…`, originator `0eb26e1d-…`).
- Rotate any GitHub Actions repository secrets that may have been exposed or used
  (`SERVER_PASSWORD`, `SSH_PRIVATE_KEY`, `SSH_PUBLIC_KEY`); rotate `FLY_API_TOKEN`
  as a precaution.

---

## (c) Recommended next steps

1. **Rotate all secrets above** before doing anything else.
2. **Audit the target systems** (`74.208.191.205`, the OpenACH database, the IONOS
   account) for signs of unauthorized access or persistence:
   - Review `~/.ssh/authorized_keys` for any unrecognized keys and remove them.
   - Review Plesk scheduled tasks / cron entries for anything unexpected.
   - Inspect the OpenACH `user_api` table for injected/unauthorized rows.
   - Review auth/access logs and fail2ban status.
3. **Purge the secrets from git history.** Deleting the files leaves the values in
   every past commit. Use [`git filter-repo`](https://github.com/newren/git-filter-repo)
   (recommended) or [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/)
   to remove `.github/workflows/*` history, then force-push and have all
   collaborators re-clone. (Rotation is still required even after purging, since
   the history may already have been cloned/forked.)
4. **Review repository access** — check who has push access and whether the repo is
   or was ever public.
5. **Add guardrails** going forward: branch protection, required reviews, secret
   scanning (GitHub push protection / Advanced Security), and a policy that no
   plaintext credentials are ever committed.

---

*Scope note: this change is cleanup and documentation only. None of the removed
workflows were run, no attempt was made to access `74.208.191.205`, and the
previously blocking "integration 403" was intentionally left unresolved.*
