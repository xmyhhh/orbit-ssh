param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$NotesFile = '',
    [string]$OutputDirectory = '',
    [string]$GhPath = ''
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this script on Windows.'
}

$repoPath = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoPath 'output/release'
}
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $outputPath)) {
    throw "Release directory not found: $outputPath"
}
if (-not $NotesFile) {
    $NotesFile = Join-Path $repoPath "docs/releases/$Tag.md"
}
if (-not (Test-Path -LiteralPath $NotesFile)) {
    throw "Release notes not found: $NotesFile"
}

function Resolve-Gh([string]$providedPath) {
    if ($providedPath) {
        if (-not (Test-Path -LiteralPath $providedPath)) {
            throw "gh executable not found at $providedPath"
        }
        return (Resolve-Path -LiteralPath $providedPath).Path
    }
    $installed = Get-Command gh.exe -ErrorAction SilentlyContinue
    if ($installed) { return $installed.Source }
    $local = Join-Path $repoPath 'output/tools/gh/bin/gh.exe'
    if (Test-Path -LiteralPath $local) { return $local }
    throw 'GitHub CLI not found. Install gh or place gh.exe in output/tools/gh/bin.'
}

function Get-GitHubToken {
    if ($env:GH_TOKEN) { return $env:GH_TOKEN }
    if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN }
    # Piping the request through PowerShell mangles the blank terminator line,
    # so the credential helper gets a real file instead.
    $input = Join-Path ([IO.Path]::GetTempPath()) "orbit-ssh-cred-$([guid]::NewGuid().ToString('N')).txt"
    try {
        [IO.File]::WriteAllText($input, "protocol=https`nhost=github.com`n`n", [System.Text.UTF8Encoding]::new($false))
        $lines = cmd /c "git -c credential.interactive=never credential fill < `"$input`"" 2>$null
        if ($LASTEXITCODE -ne 0) { return '' }
        foreach ($line in $lines) {
            $parts = $line -split '=', 2
            if ($parts.Length -eq 2 -and $parts[0] -eq 'password') { return $parts[1] }
        }
        return ''
    } finally {
        if (Test-Path -LiteralPath $input) {
            Remove-Item -LiteralPath $input -Force -ErrorAction SilentlyContinue
        }
    }
}

$gh = Resolve-Gh $GhPath
$token = Get-GitHubToken
if (-not $token) {
    throw 'No GitHub token available. Set GH_TOKEN or sign in with a Git credential helper.'
}
$previousToken = $env:GH_TOKEN
$env:GH_TOKEN = $token
try {
    $assets = Get-ChildItem -LiteralPath $outputPath -File |
        Where-Object { $_.Name -match [regex]::Escape($Tag) -or $_.Name -eq 'SHA256SUMS.txt' } |
        Sort-Object Name
    if (-not $assets) { throw "No release assets found in $outputPath" }

    $existing = & $gh release view $Tag --json tagName --jq '.tagName' 2>$null
    if ($LASTEXITCODE -eq 0 -and $existing) {
        Write-Host "Release $Tag already exists; uploading assets to it."
    } else {
        $notes = Get-Content -LiteralPath $NotesFile -Raw
        & $gh release create $Tag --title $Title --notes $notes --target main
        if ($LASTEXITCODE -ne 0) { throw "gh release create failed with exit code $LASTEXITCODE" }
    }

    foreach ($asset in $assets) {
        Write-Host "Uploading $($asset.Name)..."
        & $gh release upload $Tag $asset.FullName --clobber
        if ($LASTEXITCODE -ne 0) { throw "gh release upload failed for $($asset.Name)" }
    }

    & $gh release view $Tag
    if ($LASTEXITCODE -ne 0) { throw 'gh release view failed' }
} finally {
    $env:GH_TOKEN = $previousToken
}
