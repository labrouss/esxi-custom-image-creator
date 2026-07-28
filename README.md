# ESXi Custom Image Builder

A small internal web tool that wraps VMware PowerCLI's Image Builder cmdlets
so you can upload a base ESXi depot + an HPE SPP/SSP ISO, pick which driver
VIBs to inject, and get back a custom bootable ESXi ISO — no manual PowerCLI
session required.

**This does not reimplement VIB packaging.** All the real work (depot
parsing, acceptance-level validation, ISO packaging) is done by
`VMware.PowerCLI` running inside the container. The web app is orchestration
and UI on top of it.

## How it works

1. **Upload** — the two files upload independently, each with its own
   progress bar:
   - Base ESXi **offline-bundle .zip** (from Broadcom support — *not* the
     plain install ISO; Image Builder needs the depot format, see caveat
     below)
   - The HPE **SPP/SSP .iso** containing drivers

   A job is created on the first upload click; both files can be uploaded
   in either order, and processing (hashing/caching the base image,
   extracting the SPP/SSP) starts for each as soon as it finishes uploading
   — you don't have to wait for one before starting the other.

   Each upload section also has a **"reuse cached"** dropdown listing
   previously uploaded base images / extracted SPPs (by original filename
   and when they were cached) — pick one and click **Use** to skip
   re-uploading entirely. Useful when building a second custom image from
   the same sources, or re-running after a failed build. A **Delete** button
   next to it removes the selected cached entry (with a confirmation prompt)
   and frees its disk space — handy once a cache directory has grown or an
   entry turns out to be the wrong file (e.g. the plain installer ISO
   instead of the depot zip).
2. **Extract & inspect** — the ISO is extracted with `7z` (works without
   loop-mounting, so no `--privileged` container needed). Discovery of the
   real depot zips is **manifest-driven**: it reads
   `manifest/vmw/vmware-addon-depot.txt` inside the extracted SSP, which
   lists the exact depot zip filenames (one per ESXi major version, e.g.
   `HPE-803.x-...-Addon-depot.zip` for 8.0.3, `HPE-902.x-...` for 9.0.2).
   Only those files are loaded via `Add-EsxSoftwareDepot` — this avoids
   pulling in firmware/SUM payloads that also happen to be `.zip` files but
   aren't real ESXi depots. If the manifest isn't found (older/different SSP
   layout), it falls back to scanning for every `.zip`/`.vib` in the tree.

   On top of that, the tool detects the target ESXi version from your
   **base image's filename** (handles both `8.0.3` and `8.0U3` naming
   styles) and filters the manifest list down to the matching `HPE-<code>`
   depot(s) — e.g. uploading an ESXi 8.0.3 base image narrows a manifest
   with 803/902/910 entries down to just the 803 one. If no version can be
   detected, or none of the manifest entries match, it falls back to
   showing everything rather than guessing wrong. Either way, every package
   PowerCLI can actually see afterward is listed in the UI.
3. **Select** — you tick which packages to include (all pre-checked by
   default).
4. **Build** — the backend clones the base `standard` image profile,
   injects your selected packages by exact name/version, and exports
   whichever format(s) you chose: a bootable **ISO**, a **vLCM offline
   bundle** (`.zip`), or both in the same run. An animated progress bar
   shows while this runs (PowerCLI doesn't expose a percentage, so it's
   indeterminate), with a live-updating label showing the actual current
   step — "Adding base depot...", "Injecting N package(s)...", "Exporting
   bootable ISO... (this can take a few minutes)" — streamed from the
   PowerShell process in real time rather than only appearing once the
   whole build finishes. The full step-by-step output is also visible in
   the log panel below.
5. **Download** — grab the resulting file(s) from the browser. If you
   picked both formats, two download buttons appear. Output filenames
   include a reference to the SPP/SSP source file (e.g.
   `a1b2c3d4-Synergy_Service_Pack_SSP_2026.07.02_Z7550-98164-custom-esxi.iso`)
   so it's clear which SSP drove a given build, alongside a short job-id
   prefix for uniqueness.

## Running it

```bash
docker compose up --build
```

Then open `http://<server>:3000`. No auth is set up (matches "small team,
internal server" — put it behind your own reverse proxy/VPN if you want
access control).

Uploads, extraction working directories, and output ISOs persist in the
`esxi-data` Docker volume, laid out as:

```
/data/uploads/         # transient landing spot for in-flight multipart uploads
/data/extracted-spp/<sha256>/   # unpacked SPP/SSP contents, one dir per unique ISO
/data/extracted-esxi/<sha256>/  # cached base ESXi depot files, one per unique upload
/data/output/           # built ISOs and vLCM bundles, one per job
```

Both `extracted-spp` and `extracted-esxi` are **content-hash keyed**: if you
upload the same SPP/SSP ISO or the same base ESXi depot again (e.g. building
a second custom image from the same sources), the tool reuses what's already
on disk instead of re-extracting or re-copying it. The original uploaded
file is deleted from `/data/uploads` once it's been cached, so you're not
storing it twice.

## Known caveats / things to verify before relying on this

- **Base image must be a depot zip, not the plain install ISO.** The public
  ESXi install ISO isn't in the manifest format `Add-EsxSoftwareDepot`
  expects. Get the offline-bundle zip from Broadcom's support portal.
- **Acceptance levels**: the build script forces `PartnerSupported` on the
  cloned profile. If any HPE VIB in the SSP is `CommunitySupported`, the
  export will fail with an acceptance-level mismatch — if you hit that,
  change `-AcceptanceLevel` in `scripts/build-image.ps1` to
  `CommunitySupported` and remember the resulting hosts need
  `esxcli software acceptance set --level=CommunitySupported` too.
- **Secure Boot**: unsigned/community VIBs will block boot on Secure
  Boot-enabled hosts — test on a non-production host first.
- **SSP manifest format**: this assumes `manifest/vmw/vmware-addon-depot.txt`
  is present and lists depot zip filenames one per line (blank lines
  allowed), matching the HPE Synergy SSP layout. If HPE changes this layout
  in a future SSP release, the tool logs a warning and falls back to the
  broad scan — check `job.log` if very few or zero packages show up.
- **Version-code detection** relies on your base image's filename containing
  a recognizable version pattern (`8.0.3`, `8.0U3`, etc., or an explicit
  `HPE-<code>` substring, which is checked first and used as-is). If your
  base depot zip is renamed to something that doesn't contain the version,
  the tool can't filter and will show all depot versions found in the
  manifest — harmless, just less convenient. Check `job.log` to see what
  version code (if any) was detected.
- **Reuse list only shows entries with metadata**: `cache-meta.json` is
  written the first time a file is uploaded/extracted under this version of
  the tool. Anything already cached from before this feature existed won't
  show up in the "reuse cached" dropdowns until re-uploaded once (after
  which it'll be listed for every future job).
- **Array param passing to PowerShell**: `inspect-depots.ps1` and
  `build-image.ps1` receive file lists / VIB names / export formats as
  **JSON-encoded strings** (e.g. `-SelectedPackageNamesJson
  '["pkg1","pkg2"]'`), parsed inside the script with `ConvertFrom-Json` and
  wrapped in `@(...)` to force an array even for 0/1-element results. Two
  earlier approaches were tried and both failed in real testing:
  comma-joining bound as one literal string (`Cannot add VIB
  'pkg1,pkg2,pkg3' which is not in the depot`), and passing each value as
  a separate argv token got the first value bound correctly but treated
  the rest as unrelated positional arguments (`A positional parameter
  cannot be found that accepts argument 'pkg4'`). JSON sidesteps the
  ambiguity entirely since it's a single argv token parsed explicitly,
  not relying on PowerShell's `-File` CLI argument binder for arrays.
- **Multi-GB uploads**: `multer` is configured for up to 12GB per file
  (SPP/SSP + base depot can both be large). Increase
  `limits.fileSize` in `src/routes/upload.ts` if needed, and check your
  reverse proxy's own upload size limits if you put one in front.
- **No automatic cleanup**: `extracted-spp`, `extracted-esxi`, and `output`
  all grow over time since nothing prunes them. For a small team this is
  usually fine to manage manually (`docker exec` in and `rm -rf` old
  `sha256` folders or old job outputs), but if disk space becomes a concern,
  add a cron/cleanup job or an admin endpoint to clear entries older than N
  days.
- **No auth**: per your requirements this is open to anyone who can reach
  port 3000. Fine for an internal-only network; add a reverse-proxy
  auth layer if that changes.

## Project layout

```
Dockerfile                    # PowerShell Core + VMware.PowerCLI + Node 20 + 7z
docker-compose.yml
.github/workflows/docker-build.yml  # CI: builds the image, uploads it as a .tar artifact
backend/
  src/
    server.ts                 # Express entrypoint
    routes/upload.ts          # upload -> extract -> inspect, cache list/reuse/delete
    routes/jobs.ts            # poll status, trigger build, download
    services/extractor.ts     # 7z extraction + sha256 hashing + manifest/version parsing
    services/powercli.ts      # spawns pwsh, streams live output, parses JSON marker output
    services/cacheIndex.ts    # cache-meta.json bookkeeping for the reuse-cached UI
    services/jobManager.ts    # in-memory job state (single-process, fine for small team use)
  scripts/
    inspect-depots.ps1        # loads candidate files as depots, lists packages
    build-image.ps1           # clone profile, inject selected packages, export ISO/bundle
frontend/
  index.html
  app.ts                      # vanilla TS, bundled with esbuild into backend/public/app.js
```

## CI

`.github/workflows/docker-build.yml` builds the Docker image on every push
to `main`, on version tags (`v*`), and on pull requests, then uploads the
built image as a downloadable `.tar` artifact (via `docker save` +
`actions/upload-artifact`) — no registry push, no credentials needed. Grab
the artifact from the workflow run, then load it locally with:

```bash
docker load -i esxi-image-builder-<short-sha>.tar
```

## License

No license file is included yet — add one (e.g. MIT, Apache-2.0) before
treating this as open source or accepting external contributions.

## Extending

- **Persisting job history**: currently in-memory; swap `jobManager.ts` for
  a SQLite-backed store if you want history to survive restarts or want to
  build multiple images from the same uploaded SSP without re-uploading.
