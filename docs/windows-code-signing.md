# Windows code signing — making the installer trusted

> **Status: pipeline ready, certificate not yet obtained.** The build is
> wired to sign the NSIS installer when the signing secrets are present
> (see below); until a real certificate is registered, Windows shows
> "unknown publisher" and SmartScreen / Defender warns on first run. That
> warning cannot be removed by any code change — it needs a certificate
> tied to a verified identity. This doc is the decision + the exact steps.

## Why the warning happens

The installer aplyx ships (`aplyx_<ver>_x64-setup.exe`, NSIS) is a normal,
full-featured installer — the "untrusted publisher" dialog and the
SmartScreen "Windows protected your PC" screen are **purely about the file
being unsigned**, not about the installer format. Switching to MSI/WiX
does not help (and MSI can't carry aplyx's `-beta.N` version string
anyway — see `docs/RELEASE.md`).

Two thresholds matter:

| | Removes "unknown publisher" | Removes the SmartScreen prompt |
| --- | --- | --- |
| **OV** (organization-validated) cert | yes | only after reputation builds — weeks of downloads |
| **EV** (extended-validation) cert / Azure Trusted Signing | yes | **immediately** |

For a small project shipping betas, an OV cert means every early user still
hits SmartScreen for weeks. Go EV-equivalent from the start.

## Recommended: Azure Trusted Signing

Microsoft's own signing service. ~US$9.99/month, no hardware token, and it
is treated as EV for SmartScreen (instant pass). This is the current best
option for an individual or a small company.

**One-time setup (yours to do — needs an identity check, ~1–3 business days):**

1. Create (or use) an Azure subscription.
2. In the portal, create a **Trusted Signing account** (`Microsoft.CodeSigning`).
3. Create an **Identity Validation** request:
   - *Individual* validation if there's no LLC yet — needs a government ID.
   - *Organization* validation once the LLC exists (`docs/legal.md`) —
     needs D-U-N-S / incorporation docs. Prefer this if the timing works;
     the publisher name shown to users is the validated legal name.
4. Once validated, create a **Certificate Profile** under the account.
5. Create a service principal (App Registration) with the
   **Trusted Signing Certificate Profile Signer** role on the account,
   and note its tenant id, client id, client secret.

**Wire it into CI** — add these as repository secrets, then the
`desktop-release.yml` sign step (already present, `if:` guarded on
`WINDOWS_SIGN_ENABLED`) activates automatically:

| Secret | Value |
| --- | --- |
| `WINDOWS_SIGN_ENABLED` | `true` |
| `AZURE_TENANT_ID` | service-principal tenant id |
| `AZURE_CLIENT_ID` | service-principal client id |
| `AZURE_CLIENT_SECRET` | service-principal secret |
| `TRUSTED_SIGNING_ACCOUNT_NAME` | the Trusted Signing account name |
| `TRUSTED_SIGNING_CERT_PROFILE` | the certificate profile name |
| `TRUSTED_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` (region-specific) |

The workflow installs `trusted-signing-cli` and Tauri calls it via
`bundle.windows.signCommand` (in `tauri.windows.conf.json`), signing
`desktop.exe` **and** the NSIS installer.

## Free alternative: SignPath (open-source plan)

aplyx is MIT and public, so it qualifies for **SignPath.io's free
open-source plan**, which provides an OV certificate and a GitHub Actions
integration at no cost. Trade-off: OV, not EV — so SmartScreen still warns
until reputation accrues. Reasonable as a stopgap; not as good as Trusted
Signing. Requires a project application and review by SignPath.

## What's already done in the repo

- `tauri.conf.json` `bundle.publisher` / `bundle.copyright` set, so the
  publisher line reads "aplyx" (not blank) once a cert is attached.
- `tauri.windows.conf.json` carries a `bundle.windows.signCommand`
  placeholder that no-ops without the secrets and signs with them.
- `.github/workflows/desktop-release.yml` has an `if:`-guarded step that
  installs `trusted-signing-cli` and exposes the Azure creds to the Tauri
  build only when `WINDOWS_SIGN_ENABLED` is set.

Nothing about the app's UI, features, or installer flow changes when
signing turns on — it's the same bundle, now trusted.
