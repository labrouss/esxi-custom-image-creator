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

1. **Upload** — each source uploads independently, with its own progress bar:
   - Base ESXi **offline-bundle .zip** — required (from Broadcom support —
     *not* the plain install ISO; Image Builder needs the depot format,
     see caveat below)
   - The HPE **SPP/SSP .iso** containing drivers — optional
   - Individual **`.vib`** file(s) — optional, additive; add as many as you
     like, one at a time, on top of (or instead of) the SPP

   A job is created on the first upload click; sources can be uploaded in
   any order, and processing (hashing/caching the base image, extracting
   the SPP/SSP, caching each VIB) starts for each as soon as it finishes
   uploading. **At least one of SPP or a VIB is required** alongside the
   base image — the tool won't proceed on a bare base image with nothing
   to inject.

   Each upload section also has a **"reuse cached"** dropdown listing
   previously uploaded files (by original filename and when they were
   cached) — pick one and click **Use**/**Add** to skip re-uploading
   entirely. Useful when building a second custom image from the same
   sources, or re-running after a failed build. A **Delete** button next to
   it removes the selected cached entry (with a confirmation prompt) and
   frees its disk space — handy once a cache directory has grown or an
   entry turns out to be the wrong file (e.g. the plain installer ISO
   instead of the depot zip). VIBs already added to the current job show in
   a running list with their own **Remove** button (detaches from this job
   only — doesn't delete the cached file).
2. **Analyze** — once the base image plus at least one driver source is
   ready, an **Analyze** button appears (replacing a hint text telling you
   what's still needed). Clicking it is the explicit trigger for
   extraction/inspection below — nothing runs automatically the moment
   requirements are met, so you can keep adding more VIBs first without
   racing an auto-trigger. An indeterminate progress bar with a
   live-updating label shows real steps as they happen ("Importing
   VMware.PowerCLI module...", "Adding depot: ...", "Found N package(s)"),
   streamed from the PowerShell process the same way the build step already
   does. Once analysis finishes, the page automatically scrolls to and
   briefly highlights the Export format(s)/Profile name panel so it's
   obvious where to go next.
3. **Extract & inspect** — the SPP/SSP (if provided) is extracted with `7z`
   (works without loop-mounting, so no `--privileged` container needed).
   Discovery of the real depot zips is **manifest-driven**: it reads
   `manifest/vmw/vmware-addon-depot.txt` inside the extracted SSP, which
   lists the exact depot zip filenames (one per ESXi major version, e.g.
   `HPE-803.x-...-Addon-depot.zip` for 8.0.3, `HPE-902.x-...` for 9.0.2).
   Only those files are loaded via `Add-EsxSoftwareDepot` — this avoids
   pulling in firmware/SUM payloads that also happen to be `.zip` files but
   aren't real ESXi depots. If the manifest isn't found (older/different SSP
   layout), it falls back to scanning for every `.zip`/`.vib` in the tree.
   Any individually-added VIBs are appended to the candidate list
   regardless — they aren't run through manifest/version filtering, since
   they were deliberately hand-picked.

   On top of that, the tool detects the target ESXi version from your
   **base image's filename** (handles both `8.0.3` and `8.0U3` naming
   styles) and filters the manifest list down to the matching `HPE-<code>`
   depot(s) — e.g. uploading an ESXi 8.0.3 base image narrows a manifest
   with 803/902/910 entries down to just the 803 one. If no version can be
   detected, or none of the manifest entries match, it falls back to
   showing everything rather than guessing wrong. Either way, every package
   PowerCLI can actually see afterward is listed in the UI.
5. **Select** — you tick which packages to include (all pre-checked by
   default). If the depot(s) carry multiple versions of the same driver
   (common when a base image, an SPP, and hand-added VIBs overlap), they're
   grouped together as a radio choice instead of separate checkboxes, with
   the newer-looking version pre-selected — plus an explicit "don't include
   this driver" option, since a radio can't be natively unchecked once
   one's picked. **Select All**/**Select None** and a live "N/M selected"
   count (counting unique drivers, not raw rows) are also available.
6. **Build** — the backend clones the base `standard` image profile,
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
7. **Download** — grab the resulting file(s) from the browser. If you
   picked both formats, two download buttons appear. Output filenames
   follow whichever **Profile name** mode you chose (Job ID / SPP source
   name / Date stamp / Job ID + date / Custom) — the same human-chosen name
   embedded in the ISO also leads the filename on disk, e.g. with the SPP
   mode: `Synergy_Service_Pack_SSP_2026.07.02_Z7550-98164-a1b2c3d4-custom-
   esxi.iso`. For naming modes that don't already guarantee uniqueness on
   their own (SPP name, Date stamp, Custom — e.g. two same-day builds, or
   two builds reusing the same custom name, would otherwise silently
   overwrite each other's output file), a short job-id is appended to keep
   every build's file safe from collision; Job ID and Job ID + date modes
   already embed it, so nothing extra is added there. A summary above the
   download buttons shows exactly what was used — file names, Profile name,
   Creator, and Description — pulled from the actual values PowerCLI used
   (the profile name comes back from the PowerShell result itself, not
   recomputed on the frontend). The page automatically scrolls to and
   briefly highlights this panel once the build finishes, the same way it
   does for the Export format(s) panel once analysis completes.

A **"Previously built images"** section below the main panels lists every
ISO/bundle sitting in `/data/output`, with a Download and a Delete button
per entry — useful for cleaning up old builds or grabbing one from an
earlier session without digging through the container's filesystem.

## Image profile metadata

A separate full-width section (Export format(s) / Profile name / Creator /
Description, above "Previously built images") lets you control what gets
embedded in the image profile itself — visible via `esxcli software
profile get` on a deployed host, and in `\UPGRADE\PROFILE.XML` inside the
ISO:

- **Profile name**: five options, each with a live preview —
  **Job ID** (short id, e.g. `a1b2c3d4`), **SPP / source name** (sanitized
  SPP filename, falls back to `Custom` if none was uploaded), **Date stamp**
  (`Custom-YYYYMMDD`), **Job ID + date**, or **Custom** free text. Maps to
  `New-EsxImageProfile -Name` (as `<base-profile-name>-<suffix>`).
- **Creator**: **Default** (`InternalTooling`) or a **Custom** free-text
  value — maps to `-Vendor`. Just a label; doesn't affect validation or
  behavior.
- **Description**: **Auto-generated** (default) builds a real provenance
  string from the actual build — date, base image, driver source, and
  driver count, e.g. `Custom ESXi image built 2026-07-29 via ESXi Custom
  Image Builder. Base: VMware-ESXi-8.0U3-24022510-depot.zip. Driver source:
  Synergy_Service_Pack_SSP_2026.07.02_Z7550-98164.iso. 27 driver(s)
  injected.` — with a live preview so you see the exact text before
  building. **Inherit from base image** leaves it alone, keeping whatever
  generic release description the base ESXi depot itself carries (the only
  behavior before this option existed). **Custom** lets you write your own.

All three are computed server-side in `jobs.ts` from data the job already
has (job id, cached original filenames, selected package count) — the
frontend just renders a preview of what the backend would compute, so what
you see is what you get.

## Notifications & job tracking

- **Toasts**: a small pop-up appears top-right for key events — job
  created, drivers ready to select, build started, build complete, or a
  failure with the error message. Each auto-dismisses after 5 seconds.
- **Tasks panel**: the "Tasks" button (next to Start Over) opens a dropdown
  listing every job created in this browser, persisted in `localStorage` so
  it survives a page reload. Each row shows a short label (the SPP/base
  filename once known), a live phase badge, a **View** button to switch the
  page over to that job's current state (log, driver selection, build
  progress, or download links — whichever applies), and a **✕** to remove
  it from the tracked list (this only forgets it locally; it doesn't delete
  anything server-side).
- Since job state lives in-memory on the server (see the `jobManager.ts`
  caveat above), a tracked job shows as **expired** if the server has
  restarted since it was created — the tracking list itself has no way to
  know that ahead of time, so this is discovered when you open the panel.
- **Known limitation**: switching to a tracked job via View correctly
  restores its log, driver list, build progress, and download links (all
  driven by polling `/api/jobs/:id`, which already branches on phase), but
  the upload-section indicators (progress bars, "Using cached ✓" labels)
  aren't retroactively updated to match the job you switched to — cosmetic
  only, doesn't affect functionality.

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
docker load -i esxi-image-builder-<short-sha>.tar.gz
```

## License

No license file is included yet — add one (e.g. MIT, Apache-2.0) before
treating this as open source or accepting external contributions.

## Extending

- **Persisting job history**: currently in-memory; swap `jobManager.ts` for
  a SQLite-backed store if you want history to survive restarts or want to
  build multiple images from the same uploaded SSP without re-uploading.
