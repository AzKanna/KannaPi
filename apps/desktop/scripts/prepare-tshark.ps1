$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Resolve-Path (Join-Path $desktopRoot "..\..")
$bundle = Join-Path $desktopRoot "build\tshark"
$sourceArchive = Join-Path $bundle "source\wireshark-4.6.9.tar.xz"
$expectedMsiHash = "1975DFC96581A9B674FDA3F41AC1585963B4BA52EA9459F3B6D9CEDFAC3A7217"
$expectedSourceHash = "D062D416A1AB3A49975AAFE3A671C882DDE0562CCD71B078808CEB59D465FC0F"
$expectedTsharkHash = "662E10FD28A8C58575FE567845D0248080A2856C3D18D6F2FF7A4B4C8511F69B"
$cache = Join-Path $projectRoot ".tmp\wireshark-4.6.9"
$msi = if ($env:KANNAPI_WIRESHARK_MSI) { $env:KANNAPI_WIRESHARK_MSI } else { Join-Path $cache "Wireshark-4.6.9-x64.msi" }
$source = if ($env:KANNAPI_WIRESHARK_SOURCE) { $env:KANNAPI_WIRESHARK_SOURCE } else { Join-Path $cache "wireshark-4.6.9.tar.xz" }

function Assert-Hash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required Wireshark file is missing: $Path" }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash -ne $Expected) {
    throw "Official Wireshark SHA-256 mismatch: $Path"
  }
}

if (Test-Path -LiteralPath $bundle) {
  Assert-Hash $sourceArchive $expectedSourceHash
  $executable = Join-Path $bundle "tshark.exe"
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $bundle "COPYING.txt") -PathType Leaf)) {
    throw "The staged TShark bundle is incomplete: $bundle"
  }
  Assert-Hash $executable $expectedTsharkHash
  $version = (& $executable --version | Select-Object -First 1)
  if ($version -notmatch "4\.6\.9") { throw "Expected TShark 4.6.9, found: $version" }
  Write-Host "Verified bundled TShark 4.6.9 and corresponding source."
  exit 0
}

New-Item -ItemType Directory -Path $cache -Force | Out-Null
if (-not (Test-Path -LiteralPath $msi -PathType Leaf)) {
  Write-Host "Downloading official Wireshark 4.6.9 x64 MSI ..."
  Invoke-WebRequest -Uri "https://www.wireshark.org/download/win64/Wireshark-4.6.9-x64.msi" -OutFile $msi
}
Assert-Hash $msi $expectedMsiHash
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  Write-Host "Downloading corresponding Wireshark 4.6.9 source ..."
  Invoke-WebRequest -Uri "https://www.wireshark.org/download/src/wireshark-4.6.9.tar.xz" -OutFile $source
}
Assert-Hash $source $expectedSourceHash

$stage = Join-Path $cache ("extract-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
$process = Start-Process -FilePath "msiexec.exe" `
  -ArgumentList @("/a", ('"' + $msi + '"'), "/qn", ('TARGETDIR="' + $stage + '"')) `
  -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne 0) { throw "Wireshark administrative extraction failed: $($process.ExitCode)" }
$extracted = Join-Path $stage "Wireshark"
if (-not (Test-Path -LiteralPath (Join-Path $extracted "tshark.exe") -PathType Leaf)) {
  throw "Official MSI did not contain the expected TShark runtime"
}
Assert-Hash (Join-Path $extracted "tshark.exe") $expectedTsharkHash
Copy-Item -LiteralPath $extracted -Destination $bundle -Recurse
New-Item -ItemType Directory -Path (Join-Path $bundle "source") | Out-Null
Copy-Item -LiteralPath $source -Destination $sourceArchive
Assert-Hash $sourceArchive $expectedSourceHash
Write-Host "Staged verified TShark 4.6.9 in $bundle"
