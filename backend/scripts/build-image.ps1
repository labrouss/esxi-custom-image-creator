<#
  Loads the base ESXi depot + the driver depot files that were validated in the
  inspect phase, clones the standard image profile, injects the user-selected
  packages by exact name+version (resolving each to the specific VIB object
  rather than trusting a bare name, which would be ambiguous when the depot
  carries multiple versions of the same driver), and exports a bootable ISO
  and/or vLCM offline bundle.

  Output: "###JSON_START###{...}###JSON_END###" with success/error + output path.
#>
param(
  [Parameter(Mandatory = $true)][string]$BaseDepotPath,
  [Parameter(Mandatory = $false)][string]$DriverDepotFilesJson = '[]',
  [Parameter(Mandatory = $true)][string]$SelectedPackagesJson,
  [Parameter(Mandatory = $false)][string]$ExportFormatsJson = '["iso"]',
  [Parameter(Mandatory = $false)][string]$OutputIsoPath,
  [Parameter(Mandatory = $false)][string]$OutputBundlePath,
  [Parameter(Mandatory = $false)][string]$ProfileSuffix = "Custom"
)

$ErrorActionPreference = "Stop"

# Arrays are passed as JSON, not as multiple/comma-joined argv tokens: PowerShell's
# -File invocation does not reliably bind either style to a [string[]] parameter
# (comma-joining binds as one literal string; space-separated tokens get treated
# as unrelated positional arguments and error out — "A positional parameter
# cannot be found..."). JSON + ConvertFrom-Json sidesteps this entirely. @(...)
# forces an array even when the JSON has 0 or 1 elements, since ConvertFrom-Json
# otherwise returns a bare scalar for those cases.
$DriverDepotFiles = @($DriverDepotFilesJson | ConvertFrom-Json)
$SelectedPackages = @($SelectedPackagesJson | ConvertFrom-Json)   # each: { name, version }
$ExportFormats = @($ExportFormatsJson | ConvertFrom-Json)

function Emit-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  Write-Output "###JSON_START###$json###JSON_END###"
}

# PowerShell's stdout is buffered when redirected to a pipe (as it is when Node
# spawns this via child_process) — without an explicit flush, all output lands
# at once when the process exits rather than streaming live. Write-Host writes
# directly to the console stream, and the explicit Flush() forces it out
# immediately so the caller sees real-time progress instead of silence.
function Write-Progress-Line($msg) {
  Write-Host $msg
  [Console]::Out.Flush()
}

try {
  Write-Progress-Line "Importing VMware.PowerCLI module..."
  Import-Module VMware.PowerCLI -ErrorAction Stop | Out-Null
  Set-PowerCLIConfiguration -Scope User -ParticipateInCEIP $false -Confirm:$false | Out-Null

  Write-Progress-Line "Adding base depot: $BaseDepotPath"
  Add-EsxSoftwareDepot -DepotUrl $BaseDepotPath | Out-Null

  foreach ($f in $DriverDepotFiles) {
    Write-Progress-Line "Adding driver depot: $f"
    Add-EsxSoftwareDepot -DepotUrl $f | Out-Null
  }

  Write-Progress-Line "Looking up base image profile..."
  $base = Get-EsxImageProfile | Where-Object { $_.Name -match "standard" } | Select-Object -First 1
  if (-not $base) {
    throw "No 'standard' image profile found in the base depot. Check that the base ESXi depot zip was uploaded (not just the install ISO)."
  }

  $newProfileName = "$($base.Name)-$ProfileSuffix"
  if (Get-EsxImageProfile -Name $newProfileName -ErrorAction SilentlyContinue) {
    Write-Progress-Line "Removing pre-existing profile $newProfileName from a previous run..."
    Remove-EsxImageProfile -ImageProfile $newProfileName -Confirm:$false
  }

  Write-Progress-Line "Cloning base profile '$($base.Name)' into '$newProfileName'..."
  New-EsxImageProfile -CloneProfile $base -Name $newProfileName -Vendor "InternalTooling" -AcceptanceLevel PartnerSupported | Out-Null

  if ($SelectedPackages.Count -gt 0) {
    Write-Progress-Line "Resolving $($SelectedPackages.Count) selected package(s) to exact VIB versions..."
    $resolvedPackages = foreach ($sel in $SelectedPackages) {
      $match = Get-EsxSoftwarePackage -Name $sel.name | Where-Object { $_.Version -eq $sel.version } | Select-Object -First 1
      if (-not $match) {
        throw "Could not find package '$($sel.name)' version '$($sel.version)' in the loaded depots — it may have been in a depot that failed to load, or the version string changed between inspection and build."
      }
      $match
    }

    $labels = ($SelectedPackages | ForEach-Object { "$($_.name)@$($_.version)" }) -join ", "
    Write-Progress-Line "Injecting $($resolvedPackages.Count) package(s): $labels"
    Add-EsxSoftwarePackage -ImageProfile $newProfileName -SoftwarePackage $resolvedPackages | Out-Null
  }

  $resultIsoPath = $null
  $resultBundlePath = $null

  if ($ExportFormats -contains "iso") {
    if (-not $OutputIsoPath) { throw "ExportFormats includes 'iso' but -OutputIsoPath was not provided." }
    Write-Progress-Line "Exporting bootable ISO to $OutputIsoPath (this can take a few minutes)..."
    New-Item -ItemType Directory -Force -Path (Split-Path $OutputIsoPath) | Out-Null
    Export-EsxImageProfile -ImageProfile $newProfileName -ExportToIso -FilePath $OutputIsoPath -Force | Out-Null
    $resultIsoPath = $OutputIsoPath
    Write-Progress-Line "ISO export complete."
  }

  if ($ExportFormats -contains "bundle") {
    if (-not $OutputBundlePath) { throw "ExportFormats includes 'bundle' but -OutputBundlePath was not provided." }
    Write-Progress-Line "Exporting vLCM offline bundle to $OutputBundlePath..."
    New-Item -ItemType Directory -Force -Path (Split-Path $OutputBundlePath) | Out-Null
    Export-EsxImageProfile -ImageProfile $newProfileName -ExportToBundle -FilePath $OutputBundlePath -Force | Out-Null
    $resultBundlePath = $OutputBundlePath
    Write-Progress-Line "Bundle export complete."
  }

  Emit-Result @{
    success          = $true
    outputIsoPath    = $resultIsoPath
    outputBundlePath = $resultBundlePath
    profileName      = $newProfileName
  }
} catch {
  Emit-Result @{ success = $false; error = $_.Exception.Message }
}
