# Security notes

## Dependency audit policy

Production bridge dependencies are checked separately from the Expo build
toolchain:

```sh
npm audit --workspace bridge --omit=dev
npm audit
```

The bridge runtime audit must not contain high or critical findings. Do not use
`npm audit fix --force`: npm currently proposes incompatible downgrades of
`minecraft-protocol` and `mineflayer` for the transitive `uuid` advisory.

## Accepted build-time advisory

Expo SDK 54 pins `@expo/metro-config` to PostCSS `~8.4`, which is reported for
source-map file disclosure and denial-of-service advisories. PostCSS is used
only while exporting the web bundle in isolated GitHub Actions; it is not
shipped in the PWA bundle or loaded by the Mac mini bridge. The workflow builds
trusted repository CSS and does not accept user-supplied CSS or source maps.

This build-only risk is accepted until the app can be tested and migrated to an
Expo release whose Metro config uses a patched PostCSS version. Reassess this
entry during the Expo SDK upgrade and remove it once `npm audit` no longer
reports PostCSS.
