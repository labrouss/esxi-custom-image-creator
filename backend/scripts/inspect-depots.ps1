<#
  Adds each candidate file (zip or .vib) as a software depot and reports which
  ones PowerCLI actually accepted, plus every package visible afterward.
  This is the real validation step — filename pattern matching in Node is just
  a pre-filter; PowerCLI is the source of truth for "is this a usable depot".

  Output: a single line "###JSON_START###{...}###JSON_END###" so the Node
  caller can extract structured data from otherwise noisy PowerCLI stdout.
#>
param(
  [Parameter(Mandatory = $true)][string]$CandidateFilesJson
)

$ErrorActionPreference = "Stop"

# PowerShell's stdout is buffered when redirected to a pipe (as it is when Node
# spawns this via child_process) — without an explicit flush, all output lands
# at once when the process exits rather than streaming live. Write-Host writes
# directly to the console stream, and the explicit Flush() forces it out
# immediately so the caller sees real-time progress instead of silence.
function Write-Progress-Line($msg) {
  Write-Host $msg
  [Console]::Out.Flush()
}

# Arrays are passed as JSON, not as multiple/comma-joined argv tokens: PowerShell's
# -File invocation does not reliably bind either style to a [string[]] parameter
# (comma-joining binds as one literal string; space-separated tokens get treated
# as unrelated positional arguments and error out). JSON + ConvertFrom-Json sidesteps
# this entirely. @(...) forces an array even when the JSON has 0 or 1 elements,
# since ConvertFrom-Json otherwise returns a scalar for those cases.
$CandidateFiles = @($CandidateFilesJson | ConvertFrom-Json)

Write-Progress-Line "Importing VMware.PowerCLI module..."
Import-Module VMware.PowerCLI -ErrorAction Stop | Out-Null
Set-PowerCLIConfiguration -Scope User -ParticipateInCEIP $false -Confirm:$false | Out-Null

$loaded = @()
$failed = @()

Write-Progress-Line "Validating $($CandidateFiles.Count) candidate file(s) as depots..."
foreach ($file in $CandidateFiles) {
  Write-Progress-Line "  Adding depot: $file"
  try {
    Add-EsxSoftwareDepot -DepotUrl $file -ErrorAction Stop | Out-Null
    $loaded += $file
  } catch {
    Write-Progress-Line "  Rejected (not a valid depot): $file"
    $failed += @{ file = $file; reason = $_.Exception.Message }
  }
}

Write-Progress-Line "Listing available packages across $($loaded.Count) loaded depot(s)..."
$packages = Get-EsxSoftwarePackage | ForEach-Object {
  @{
    name    = $_.Name
    vendor  = $_.Vendor
    version = $_.Version
    vibId   = $_.Id
  }
}
Write-Progress-Line "Found $($packages.Count) package(s)."

$result = @{
  loadedDepotFiles = $loaded
  failedFiles      = $failed
  packages         = $packages
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
Write-Output "###JSON_START###$json###JSON_END###"
