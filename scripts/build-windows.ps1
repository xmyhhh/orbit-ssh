param(
    [string]$OutputName = 'OrbitSSH-windows-x64.exe',
    [string]$WailsPath = ''
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this script on Windows.'
}
if ([IO.Path]::GetFileName($OutputName) -ne $OutputName -or $OutputName -notmatch '\.exe$') {
    throw 'OutputName must be an .exe filename without a directory.'
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

$repoPath = Split-Path -Parent $PSScriptRoot
if ($WailsPath) {
    $WailsPath = (Resolve-Path -LiteralPath $WailsPath).Path
} elseif (Get-Command wails.exe -ErrorAction SilentlyContinue) {
    $WailsPath = (Get-Command wails.exe).Source
} elseif (Test-Path -LiteralPath (Join-Path $repoPath 'output/tools/wails.exe')) {
    $WailsPath = Join-Path $repoPath 'output/tools/wails.exe'
}

Push-Location $repoPath
try {
    Push-Location (Join-Path $repoPath 'frontend')
    try {
        if (-not (Test-Path -LiteralPath node_modules)) {
            Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund')
        }
        Invoke-Checked 'npm.cmd' @('test')
        Invoke-Checked 'npm.cmd' @('run', 'build')
    } finally {
        Pop-Location
    }

    # Go embeds frontend/dist; finish the frontend build before Go checks.
    Invoke-Checked 'go' @('test', './...')
    Invoke-Checked 'go' @('test', '-tags', 'androidtest', './...')
    Invoke-Checked 'go' @('vet', './...')
    $buildArguments = @('build', '-s', '-m', '-nosyncgomod', '-trimpath', '-platform', 'windows/amd64', '-webview2', 'browser', '-o', $OutputName, '-nocolour')
    if ($WailsPath) {
        Invoke-Checked $WailsPath $buildArguments
    } else {
        Invoke-Checked 'go' (@('run', 'github.com/wailsapp/wails/v2/cmd/wails@v2.11.0') + $buildArguments)
    }

    $exePath = Join-Path $repoPath "build/bin/$OutputName"
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "Build did not produce $exePath"
    }
    Get-Item -LiteralPath $exePath | Format-List FullName, Length, LastWriteTime
    Get-FileHash -Algorithm SHA256 -LiteralPath $exePath | Format-List Algorithm, Hash, Path
} finally {
    Pop-Location
}
