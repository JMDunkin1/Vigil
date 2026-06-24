# Vigil iOS Remote MDM Setup

Vigil's static supervised USB profile and remote MDM are separate setup paths. A phone can be supervised and have the static Vigil restrictions profile installed while remote/wireless MDM is still completely unconfigured.

When you need the iPhone UDID, read it locally with `pymobiledevice3 usbmux list --usb` and use the reported identifier as `<IPHONE_UDID>`. The static supervised profile `tech.caseline.vigil.ios-lock` can keep working unplugged while you finish this remote MDM setup; do not remove or reinstall that profile just to work on wireless MDM.

Run the read-only doctor:

```sh
npm run ios:mdm:doctor
```

Use `-- --json` for machine-readable output, or `-- --strict` if a CI/checkpoint should exit non-zero until wireless MDM is ready.

## Apple Account Reality

Wireless MDM cannot be completed with the Apple Development identities already in Keychain. It needs a real Apple MDM APNs push certificate whose topic starts with `com.apple.mgmt.`.

Apple's documented route is the MDM Vendor CSR Signing Certificate. Apple says this certificate signs your own or customer CSRs so they can generate an MDM Push Certificate at `identity.apple.com`, and the Account Holder of an Apple Developer Program or Apple Developer Enterprise Program account must contact Apple to request access:

- https://developer.apple.com/help/account/certificates/mdm-vendor-csr-signing-certificate/
- https://developer.apple.com/help/account/certificates/certificates-overview/

A solo/personal paid Apple Developer Program account is therefore not automatically enough. It is technically in the program named by Apple, but the MDM Vendor CSR signing capability is request-only and Apple may deny it if the account does not look like a real MDM vendor/service use case. Realistic fallback options:

- Request MDM Vendor CSR Signing access from Apple as the Account Holder and wait for approval.
- Use an existing MDM provider such as Jamf, Kandji, Mosyle, SimpleMDM, Addigy, or Apple Business Essentials for wireless management, while keeping Vigil's static USB profile for local restrictions.
- Continue using the static supervised USB profile path until Apple grants MDM push credentials.

Do not generate or paste fake APNs material. A self-signed certificate can be useful for the local device identity payload below, but it cannot wake an iPhone through APNs.

## Public HTTPS Route

The iPhone must be able to reach Vigil's MDM endpoints over public HTTPS after the enrollment profile is installed:

- `GET /mdm/enroll.mobileconfig`
- `PUT` or `POST /mdm/checkin`
- `PUT` or `POST /mdm/connect`
- `GET /mdm/policy.mobileconfig`

Practical option for this Mac: Cloudflare Tunnel.

1. Install and authenticate `cloudflared`.
2. Create a named tunnel and DNS route such as `vigil-mdm.example.com`.
3. Route only `/mdm/*` to the local Vigil server, normally `http://127.0.0.1:8787`.
4. Leave every other public path blocked at the proxy.

Example Cloudflare Tunnel config:

```yaml
tunnel: vigil-mdm
credentials-file: /Users/YOU/.cloudflared/vigil-mdm.json

ingress:
  - hostname: vigil-mdm.example.com
    path: /mdm/*
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Then set:

```sh
VIGIL_MDM_PUBLIC_BASE_URL=https://vigil-mdm.example.com
```

Other workable options are a small VPS reverse proxy with Caddy/Nginx over Tailscale Funnel or a router port-forward to this Mac with a normal TLS certificate. The requirement is the same either way: public HTTPS, valid TLS, and only `/mdm/*` exposed.

Apple also documents the APNs network side: devices use APNs over port `5223` with `443` fallback, and the MDM service sends APNs notifications over `443` or `2197`.

## Configure From Real Files

The configurator only stores values and certificate files you provide. It does not create Apple MDM push certificates, SCEP identities, or working placeholder certs.

Generate the local identity payload that Vigil embeds in the enrollment profile:

```sh
npm run ios:mdm:identity -- --out "$HOME/.vigil-mdm/ios-mdm-identity.p12"
```

The helper prints an `Identity UUID`, the `.p12` path, and a password file path if it generated one. Keep the `.p12`, key, and password file private. This is only the device identity payload for enrollment; it is not the Apple APNs push certificate.

After Apple grants MDM Vendor CSR access, generate the MDM push certificate through Apple's flow, download it from the Apple Push Certificates Portal, install it in Keychain, export it as PKCS#12, and record the matching `com.apple.mgmt.*` topic. If you renew later, use the same Apple Account/Managed Apple Account that created the push certificate or enrolled devices may need to be re-enrolled.

```sh
VIGIL_MDM_ENABLED=true \
VIGIL_MDM_PUBLIC_BASE_URL=https://vigil-mdm.example.com \
VIGIL_MDM_TOPIC=com.apple.mgmt.your-topic \
VIGIL_MDM_IDENTITY_UUID=11111111-2222-3333-4444-555555555555 \
VIGIL_MDM_IDENTITY_P12=/secure/path/device-identity.p12 \
VIGIL_MDM_IDENTITY_P12_PASSWORD='identity-password-if-any' \
VIGIL_MDM_PUSH_P12=/secure/path/apple-mdm-push.p12 \
VIGIL_MDM_PUSH_P12_PASSWORD='push-password-if-any' \
npm run ios:mdm:configure
```

Equivalent flags are available:

```sh
npm run ios:mdm:configure -- \
  --enable \
  --public-base-url https://vigil.example.com \
  --topic com.apple.mgmt.your-topic \
  --identity-uuid 11111111-2222-3333-4444-555555555555 \
  --identity-p12 /secure/path/device-identity.p12 \
  --push-p12 /secure/path/apple-mdm-push.p12
```

Add `--dry-run` to validate and print the doctor output without saving.

## Enrollment And Verification

1. Start Vigil on the Mac and keep the public tunnel/reverse proxy running.
2. Confirm the tunnel reaches only MDM paths:

   ```sh
   curl -i https://vigil-mdm.example.com/mdm/enroll.mobileconfig
   curl -i https://vigil-mdm.example.com/
   ```

   The first should return a mobileconfig only after setup blockers are fixed; the second should be blocked by the proxy.

3. Save the real settings:

   ```sh
   npm run ios:mdm:configure
   npm run ios:mdm:doctor
   ```

4. Download the enrollment profile from Vigil:

   ```sh
   open http://127.0.0.1:8787/api/devices/ios/mdm/enrollment.mobileconfig
   ```

5. Put that `.mobileconfig` on the already-supervised iPhone with AirDrop, Safari, Mail, Finder, or Apple Configurator. On the iPhone, install it from Settings when iOS shows `Profile Downloaded` or `Enroll in Vigil`; Apple also surfaces installed profiles under Settings > General > VPN & Device Management.
6. Watch for `TokenUpdate`:

   ```sh
   npm run ios:mdm:doctor -- --json
   ```

   Success signs are `remoteMdm.enrolledDeviceCount` greater than `0`, `remoteMdm.lastCheckInAt` populated, and the device's UDID stored in state.

7. Push a policy refresh from the app or API:

   ```sh
   curl -X POST http://127.0.0.1:8787/api/devices/ios/mdm/queue-policy \
     -H 'X-Vigil-Intent: vigil-app'
   npm run ios:mdm:doctor -- --json
   ```

   Success signs are `lastPushStatus` of `sent`, no `lastPushError`, and queued commands moving to sent/acknowledged as the phone checks `/mdm/connect`.

## External Prerequisites

- A supervised iPhone that will install the MDM enrollment profile.
- A public HTTPS URL with a valid TLS certificate routing `/mdm/*` to Vigil.
- Apple-approved MDM Vendor CSR Signing access for the Account Holder, then an Apple MDM APNs push certificate from the Apple Push Certificates Portal, exported as PKCS#12.
- The APNs MDM topic from that push certificate, usually `com.apple.mgmt.<id>`.
- A real device identity PKCS#12 payload, or a future SCEP implementation; placeholder identity bytes are not sufficient.
- Installation of the generated enrollment profile on the supervised iPhone.

Apple Development certificates in Keychain are not MDM APNs push certificates. Vigil can check local configuration shape, but the final proof is a supervised iPhone TokenUpdate plus a successful APNs wake-up for a queued MDM command.

## Finish Checklist

- Static supervised Vigil profile remains installed and active.
- Public HTTPS `/mdm/*` route works from outside the Mac.
- Apple has granted MDM Vendor CSR Signing access, or you have chosen a hosted MDM fallback.
- Apple MDM push certificate `.p12` and topic are real, current, and stored safely.
- `npm run ios:mdm:identity` has created the local identity `.p12`.
- `npm run ios:mdm:configure -- --dry-run` reports no setup blockers.
- `npm run ios:mdm:configure` saves the settings.
- `npm run ios:mdm:doctor` reports enrollment ready before installing the profile.
- iPhone installs the generated MDM enrollment profile without removing the static USB profile.
- Doctor shows `enrolledDeviceCount > 0` and `lastCheckInAt` after TokenUpdate.
- Queue/push test shows APNs push accepted and the command acknowledged.
