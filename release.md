# Release Process

Releases are fully automated via `.github/workflows/release.yml`. Pushing a tag matching `v*` triggers a build matrix that produces every artifact and creates a single GitHub Release.

## What gets produced

| Artifact | Platform | Built by |
|----------|----------|----------|
| `diveplay_<ver>_x64-setup.exe` | Windows installer (NSIS) | `tauri-action` on `windows-latest` |
| `diveplay_<ver>_amd64.deb` | Debian/Ubuntu package | `tauri-action` on `ubuntu-22.04` |
| `diveplay_<ver>_amd64.AppImage` | Portable Linux | `tauri-action` on `ubuntu-22.04` (linuxdeploy + appimagetool) |
| `diveplay-web.html` | Single-file portable web player | `cp dist/index.html …` step, uploaded once from the Linux runner |

`bundle.targets` in `src-tauri/tauri.conf.json` controls which artifacts each OS produces. `tauri-action` reads it directly — no `--target` flag is needed in the workflow.

## Cutting a release — step by step

1. **Make sure `main` is green** locally and on CI. The release workflow only runs the build/bundle — there's no separate test gate.

2. **Bump the version in three files** to the same value (semver, plus optional prerelease suffix like `-rc1` / `-beta2`):
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/tauri.conf.json` → `"version"`

3. **Refresh the lockfiles** so they stay in sync with the manifests (otherwise CI rebuilds them and the diff drifts):
   ```bash
   cd src-tauri && cargo update -p diveplay
   cd ..       && npm install --package-lock-only
   ```

4. **Commit** the bump together with whatever feature/fix commits go into the release. Conventional-commit style:
   ```
   feat: <short summary>
   fix: <short summary>
   chore: bump version to <ver>
   ```

5. **Tag with the same version prefixed by `v`** and push. The tag is the trigger — *no manual workflow_dispatch is needed*:
   ```bash
   git push origin main
   git tag -a v1.0.8 -m "Release v1.0.8"
   git push origin v1.0.8
   ```

   For a pre-release dry run, use a hyphenated tag like `v1.0.8-rc1`. The workflow detects the dash via `contains(github.ref_name, '-')` and marks the GitHub Release as **prerelease** automatically — no workflow edits required.

6. **Watch the run** at <https://github.com/dougmb/diveplay/actions>. Expected duration: ~10-15 min (Windows + Linux runners build in parallel).

7. **Verify the Release** at <https://github.com/dougmb/diveplay/releases>:
   - Four artifacts attached (`.exe`, `.deb`, `.AppImage`, `diveplay-web.html`).
   - Body text: "Download the Desktop App installer or the portable standalone Web player below."
   - Prerelease flag matches your intent.

## What the workflow does

```
v1.0.8 tag pushed
  │
  ├── windows-latest runner ────────────────────────┐
  │     1. checkout                                 │
  │     2. setup-node@v4 (node 20)                  │
  │     3. dtolnay/rust-toolchain@stable            │
  │     4. (Linux deps step — skipped)              │
  │     5. npm install                              │
  │     6. tauri-action ──► .exe (NSIS)             │
  │                          uploaded to release    │
  │                                                 │
  └── ubuntu-22.04 runner ──────────────────────────┤
        1. checkout                                 │
        2. setup-node@v4 (node 20)                  │
        3. dtolnay/rust-toolchain@stable            │
        4. apt-get install libwebkit2gtk-4.1-dev    │
                          libappindicator3-dev      │
                          librsvg2-dev              │
                          patchelf                  │
                          libssl-dev                │
        5. npm install                              │
        6. tauri-action (NO_STRIP=true) ──►         │
              ├── .deb (with `ffmpeg` apt-dep)      │
              └── .AppImage (linuxdeploy + appimage)│
                  uploaded to release               │
        7. cp dist/index.html dist/diveplay-web.html│
        8. softprops/action-gh-release ──►          │
              diveplay-web.html uploaded once       │
                                                    │
                              same GitHub Release ──┘
```

`tauri-action` deduplicates by `tagName`, so both runners attach their artifacts to the same Release object. The portable web HTML is uploaded only from the Linux runner (`if: matrix.platform == 'linux'`) so it doesn't appear twice.

## Why certain things are the way they are

- **`NO_STRIP: "true"`** — the `strip` binary embedded in `linuxdeploy-x86_64.AppImage` is built against older binutils that don't recognise the `.relr.dyn` ELF section emitted by newer toolchains. Without this env var, building on an up-to-date host fails. Ubuntu 22.04 doesn't currently trigger it, but the flag is cheap insurance and matches the workaround we verified locally on Arch.

- **System `ffmpeg` on Linux** — `bundle.linux.deb.depends: ["ffmpeg"]` makes `apt install ./diveplay_*.deb` pull in FFmpeg. At runtime `get_sidecar_path` in `src-tauri/src/lib.rs` walks: bundled resources → XDG/AppImage dirs → exe-relative → dev paths → `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin` → bare name (`PATH`). The system binary fallback is what makes the `.deb` work cleanly.

- **Two runners, one Release** — `permissions: contents: write` is set at job level, so both matrix entries can attach artifacts. The first runner to finish creates the Release; subsequent runners append to it.

- **Single-file web HTML** — Vite's `viteSingleFile` plugin inlines the entire frontend into `dist/index.html`. The Linux runner's `cp` step just renames that file so it's an obvious download in the Release page.

## Hotfixing a botched release

If a tag goes out wrong (e.g. wrong version, broken build):

1. Delete the GitHub Release manually (Releases page → ⋮ → Delete).
2. Delete the tag locally and remotely (**destructive — confirm before running**):
   ```bash
   git tag -d v1.0.8
   git push origin :refs/tags/v1.0.8
   ```
3. Fix the issue, bump to the next patch (e.g. `v1.0.9`), and tag again. Avoid re-using the same version number — npm/cargo/tauri caches and any user who already pulled the bad version will conflict.

For prereleases (`-rc`, `-beta`), it's safer to just bump the suffix (`-rc1` → `-rc2`) rather than overwrite.

## Local sanity check before tagging

You don't have to, but to catch obvious breakage before burning a tag:

```bash
# Type check + frontend build
npm run build

# Rust check (fast, no full release build)
cd src-tauri && cargo check

# Optional: full local AppImage build (Linux only, ~10 min)
cd .. && npm run tauri build -- --bundles appimage
# Output: src-tauri/target/release/bundle/appimage/diveplay_<ver>_amd64.AppImage
```

Note: on Arch (and other distros with newer binutils), `tauri build` for AppImage will fail at `linuxdeploy`'s strip step. Work around locally with:
```bash
NO_STRIP=true npm run tauri build -- --bundles appimage
```
The same env var is already wired into CI.
