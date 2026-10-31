# Klipper Farm: preparation for the existing update button

This directory prepares a release candidate. It does not publish an application update, publish runtime assets, sign a manifest, or run GitHub Actions.

The current Windows acceptance run is [FIX4 / 41195183959](https://github.com/sanozhukov3737-oss/klipper-farm-updates/actions/runs/41195183959), commit `9a559e32a4faa4b583f990d0b5285138c5ab1895` on `r146-offline-voice-quality`. Completion and acceptance must be checked before using its output. The existing stable release remains `r144-ota`.

## Candidate preparation

`prepare-production-candidate.py` accepts the exact FIX4 source archive and acceptance workflow, a successful run response, its accepted `update-provenance.json`, and the current signed stable manifest. It rejects pending or unsuccessful runs and unauthenticated stable metadata. The stable public key and endpoint stay unchanged.

The preparation creates separate source and workflow outputs with the next embedded update sequence, and binds the new source archive hash in that workflow. The resulting application needs its own complete Windows acceptance run. A successful FIX4 run alone does not make the prepared production candidate accepted.

The current public stable manifest has sequence 144. Its Ed25519 signature was verified using the application's unchanged embedded public key. `public-stable-r144-fixture.json` is a public test fixture; it must not be used as a substitute for a fresh stable manifest when preparing a release.

## Publication prerequisites

1. Accept the production candidate on Windows, including fresh component installation, component reuse during `/UPDATE`, native tests, the actual installed WebView and semantic bridge. Its embedded sequence, acceptance provenance and signed update manifest must agree.
2. Publish the exact accepted runtime archive using the reviewed `publish-update-runtime.template.yml`. It is a separate content-addressed asset on a dedicated prerelease with `--latest=false`; existing assets must not be overwritten. Verify its publicly downloaded SHA256 and size before the application update becomes available.
3. Sign `update-v20.json` with the original custom Ed25519 private key. The signer requires a key matching the embedded public key and an EXE no larger than 512 MiB. The original private key's location has not been established in this session. A Tauri/minisign key does not replace it.
4. Publish the exact accepted EXE and signed manifest to the existing stable channel. Verify the public manifest, installer identity and update sequence with the application's updater before describing the update as available through the button.

The model is not bundled again with routine application updates. Matching installed components are verified and reused; missing or damaged components are fetched and verified by the installer.

No stable release or signing key is changed by this preparation.
