# Publish Sentinel QC on Render (free)

The root `render.yaml` configures a free Node 24 web service in Singapore, one
instance, HTTPS cookies, and a health check. The existing shared login is unchanged.
Your Mac's local database is not uploaded.

## First deployment

1. Sign in to https://dashboard.render.com/ or create your account.
2. Connect GitHub and grant access only to `te22js/sentinel-qc`.
3. Choose **New → Blueprint**, select that repository and branch `main`, and use
   the root `render.yaml`.
4. Verify the service shows the **Free** plan with **no paid disk or database**,
   then deploy.
5. Wait for **Live** and open the HTTPS URL Render assigns. Sign in with the
   existing shared credentials.

No purchased domain is required: Render supplies an `onrender.com` address and
HTTPS. The startup script automatically uses that address for origin checks.

## Free-plan limitations

Free hosting has an ephemeral filesystem. SQLite data, sessions, the audit chain,
and generated reports are lost on restart, redeploy, or idle spin-down. The service
spins down after 15 minutes without traffic and takes around a minute to wake.
Download reports promptly; do not use this free instance as the only copy of
important records. This hosting reset is separate from normal logout/expiry cleanup.

Review https://render.com/docs/free for current limits. No paid resources are
included in this Blueprint. Automatic deploys are disabled to avoid unexpected
workspace resets on every GitHub push. To update deliberately, use **Manual Deploy
→ Deploy latest commit**. Stay on the Hobby workspace plan; avoid paid add-ons and
set a zero build-spend limit if a payment method is attached. Free usage can be
suspended when included allowances are exhausted.

## Add a custom domain quickly

You must own the domain; buying one is separate from free hosting.

1. In the Render service, open **Settings → Custom Domains → Add Custom Domain**.
   Use a subdomain such as `qc.yourdomain.com`.
2. At your domain registrar, add the exact DNS record Render shows. For a `qc`
   subdomain this is normally a CNAME to your assigned `onrender.com` hostname.
   Remove conflicting records for that same name, not unrelated DNS records.
3. Verify the domain in Render and wait for its HTTPS certificate to be ready.
4. Set the service environment variable `SENTINEL_PUBLIC_ORIGIN` to the exact
   new origin, for example `https://qc.yourdomain.com` (no path).
5. Deploy/restart and use the custom domain for all logins. The old Render address
   will no longer accept browser mutations because of the exact origin check.

Render manages the TLS certificate. Follow its displayed records for root domains:
https://render.com/docs/custom-domains

## Optional persistent storage later

When ready to pay for storage, change the plan to `starter`, set
`SENTINEL_DATA_DIR=/var/data/sentinel`, and attach a 1 GB disk at `/var/data`.
Keep one instance; this SQLite setup does not support independent replicas.
Export needed reports before upgrading because free-instance data is not copied
in automatically. Review https://render.com/pricing before approving costs.

## Verify before sharing

After deployment, check sign-in, two separate browser profiles, assay entry, PDF
downloads, and sign-out. Local checks do not replace this hosted smoke test.
