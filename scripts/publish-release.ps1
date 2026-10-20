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

# Native commands report failures through the exit code, so stderr must not
# abort the script before the code can be inspected.
function Invoke-Gh([string[]]$Arguments, [switch]$AllowFailure) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $gh @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "gh $($Arguments -join ' ') failed with exit code $code"
    }
    return $code
}

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

    $existing = Invoke-Gh @('release', 'view', $Tag, '--json', 'tagName', '--jq', '.tagName') -AllowFailure
    if ($existing -eq 0) {
        Write-Host "Release $Tag already exists; uploading assets to it."
    } else {
        $notes = Get-Content -LiteralPath $NotesFile -Raw
        Invoke-Gh @('release', 'create', $Tag, '--title', $Title, '--notes', $notes, '--target', 'main') | Out-Null
    }

    foreach ($asset in $assets) {
        Write-Host "Uploading $($asset.Name)..."
        Invoke-Gh @('release', 'upload', $Tag, $asset.FullName, '--clobber') | Out-Null
    }

    Invoke-Gh @('release', 'view', $Tag) | Out-Null
} finally {
    $env:GH_TOKEN = $previousToken
}
