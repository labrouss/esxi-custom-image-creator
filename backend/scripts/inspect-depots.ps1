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

# Arrays are passed as JSON, not as multiple/comma-joined argv tokens: PowerShell's
# -File invocation does not reliably bind either style to a [string[]] parameter
# (comma-joining binds as one literal string; space-separated tokens get treated
# as unrelated positional arguments and error out). JSON + ConvertFrom-Json sidesteps
# this entirely. @(...) forces an array even when the JSON has 0 or 1 elements,
# since ConvertFrom-Json otherwise returns a scalar for those cases.
$CandidateFiles = @($CandidateFilesJson | ConvertFrom-Json)

Import-Module VMware.PowerCLI -ErrorAction Stop | Out-Null
Set-PowerCLIConfiguration -Scope User -ParticipateInCEIP $false -Confirm:$false | Out-Null

$loaded = @()
$failed = @()

foreach ($file in $CandidateFiles) {
  try {
    Add-EsxSoftwareDepot -DepotUrl $file -ErrorAction Stop | Out-Null
    $loaded += $file
  } catch {
    $failed += @{ file = $file; reason = $_.Exception.Message }
  }
}

$packages = Get-EsxSoftwarePackage | ForEach-Object {
  @{
    name    = $_.Name
    vendor  = $_.Vendor
    version = $_.Version
    vibId   = $_.Id
  }
}

$result = @{
  loadedDepotFiles = $loaded
  failedFiles      = $failed
  packages         = $packages
}

$json = $result | ConvertTo-Json -Depth 6 -Compress
Write-Output "###JSON_START###$json###JSON_END###"
