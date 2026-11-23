# Install Cerium Host for the current user. Pass -Nightly or -Version when invoking as a script.
[CmdletBinding(DefaultParameterSetName = 'Stable')]
param(
    [Parameter(ParameterSetName = 'Nightly', Mandatory = $true)][switch]$Nightly,
    [Parameter(ParameterSetName = 'Pinned', Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
$repo = 'CeriumHQ/cerium'
$api = "https://api.github.com/repos/$repo/releases"
if (-not $Version) {
    if ($Nightly) {
        $page = 1
        do {
            $batch = Invoke-RestMethod -Uri "${api}?per_page=100&page=$page" -UseBasicParsing
            $release = $batch |
                Where-Object { $_.prerelease -and $_.tag_name -match '^v\d+\.\d+\.\d+-nightly\.n?\d+$' } |
                Select-Object -First 1
            $page++
        } while (-not $release -and $batch.Count -eq 100)
    } else {
        $release = Invoke-RestMethod -Uri "$api/latest" -UseBasicParsing
    }
    $Version = $release.tag_name
}
$Version = $Version -creplace '^v', ''
if ($Version -cnotmatch '\A[0-9]+\.[0-9]+\.[0-9]+(-nightly\.n?[0-9]+)?\z') {
    throw 'No matching Cerium release found.'
}

# The machine architecture also works in a 32-bit or x64-emulated PowerShell.
$machine = Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1 -ExpandProperty Architecture
switch ($machine) {
    9 { $arch = 'x64' }
    12 { $arch = 'arm64' }
    default { throw "Unsupported Windows architecture: $machine" }
}

$root = if ($env:CERIUM_HOST_DIR) { $env:CERIUM_HOST_DIR } else { Join-Path $env:LOCALAPPDATA 'CeriumHost' }
$root = [IO.Path]::GetFullPath($root)
$bin = Join-Path $root 'bin'
[void][IO.Directory]::CreateDirectory($bin)
$layout = "cerium-host-$Version-win32-$arch"
$archive = "$layout.zip"
$url = "https://github.com/$repo/releases/download/v$Version/$archive"
$staging = Join-Path $root ('.install-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($staging)
try {
    $zip = Join-Path $staging $archive
    $checksum = Join-Path $staging 'checksum'
    Write-Host "Downloading $archive..."
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $checksum
    Write-Host "Verifying SHA-256 checksum..."
    $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([IO.File]::ReadAllText($checksum).Trim() -cne "$hash  $archive") {
        throw "Checksum mismatch for $archive."
    }
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $zip -C $staging
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $archive." }
    $package = Join-Path $staging $layout
    $node = Join-Path $package 'runtime\node.exe'
    $entry = Join-Path $package 'bin\standalone.mjs'
    $reported = & $node $entry --version
    if ($LASTEXITCODE -ne 0 -or $reported -ne $Version) { throw 'The downloaded host could not start.' }

    # Running services continue to use this bootstrap while updates switch current-version.
    $runtime = Join-Path $root 'runtime'
    $releases = Join-Path $root 'releases'
    [void][IO.Directory]::CreateDirectory($runtime)
    [void][IO.Directory]::CreateDirectory($releases)
    $selected = "$Version-" + [Guid]::ParseExact($hash.Substring(0, 32), 'N').ToString()
    $destination = Join-Path $releases $selected
    $pointer = Join-Path $root 'current-version'
    $upgrading = [IO.File]::Exists($pointer)
    $lockDir = Join-Path $root '.install-lock'
    try {
        [void](New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop)
    } catch {
        throw "Another installer or updater holds $lockDir."
    }
    try {
        if (-not [IO.File]::Exists((Join-Path $runtime 'node.exe'))) {
            [IO.File]::Copy($node, (Join-Path $staging 'bootstrap-node.exe'))
            [IO.File]::Move((Join-Path $staging 'bootstrap-node.exe'), (Join-Path $runtime 'node.exe'))
        }
        [IO.File]::Copy((Join-Path $package 'runtime\LICENSE'), (Join-Path $runtime 'LICENSE'), $true)
        if (-not [IO.Directory]::Exists($destination)) { [IO.Directory]::Move($package, $destination) }
        foreach ($script in 'cerium-host.cmd', 'standalone.mjs') {
            $source = Join-Path $staging $script
            $target = Join-Path $bin $script
            [IO.File]::Copy((Join-Path (Join-Path $destination 'bin') $script), $source)
            if ([IO.File]::Exists($target)) {
                [IO.File]::Replace($source, $target, (Join-Path $staging "old-$script"))
            } else {
                [IO.File]::Move($source, $target)
            }
        }
        $next = Join-Path $staging 'current-version'
        [IO.File]::WriteAllText($next, "$selected`n", [Text.Encoding]::ASCII)
        if ([IO.File]::Exists($pointer)) {
            [IO.File]::Replace($next, $pointer, (Join-Path $staging 'old-pointer'))
        } else {
            [IO.File]::Move($next, $pointer)
        }
    } finally {
        if ([IO.Directory]::Exists($lockDir)) { [IO.Directory]::Delete($lockDir, $false) }
    }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $bin) {
        $newPath = (@($userPath, $bin) | Where-Object { $_ }) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$bin;$env:Path" }
    Write-Host "Installed Cerium Host $Version in $root"
    if ($upgrading -and [IO.File]::Exists((Join-Path $env:USERPROFILE '.cerium\account.json'))) {
        Write-Host "`nRestart the service to pick up the new version:`n  cerium-host service restart"
    } else {
        Write-Host "`nSign in and start the service:`n  cerium-host login`n  cerium-host service install"
    }
} finally {
    [IO.Directory]::Delete($staging, $true)
}
