param(
    [string]$Version = '',
    [string]$ReleaseLabel = '',
    [string]$OutputDirectory = '',
    [string]$WailsPath = '',
    [string]$NsisPath = '',
    [string[]]$ExtraArtifact = @(),
    [switch]$SkipBuild,
    [switch]$PortableOnly,
    [switch]$InstallerOnly
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this script on Windows.'
}
if ($PortableOnly -and $InstallerOnly) {
    throw 'PortableOnly and InstallerOnly cannot be used together.'
}

$nsiVersion = '3.13'
$nsiSha256 = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
$nsiUrl = "https://sourceforge.net/projects/nsis/files/NSIS%203/$nsiVersion/nsis-$nsiVersion.zip/download"
$webView2Url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
$wailsVersion = 'v2.11.0'
$repoPath = Split-Path -Parent $PSScriptRoot

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

function Resolve-ProductVersion([string]$value) {
    if (-not $value) {
        $config = Get-Content -LiteralPath (Join-Path $repoPath 'wails.json') -Raw | ConvertFrom-Json
        $value = [string]$config.info.productVersion
    }
    $value = $value.Trim()
    if ($value.StartsWith('v')) {
        $value = $value.Substring(1)
    }
    if ($value -notmatch '^[0-9]+(\.[0-9]+){0,3}$') {
        throw "Version must contain one to four numeric parts, for example 2.0.0. Got: $value"
    }
    return $value
}

function Get-FourPartVersion([string]$value) {
    $parts = @($value.Split('.'))
    while ($parts.Count -lt 4) {
        $parts += '0'
    }
    return ($parts -join '.')
}

function Resolve-Nsis([string]$providedPath) {
    if ($providedPath) {
        if (Test-Path -LiteralPath $providedPath -PathType Container) {
            $providedPath = Join-Path $providedPath 'makensis.exe'
        }
        if (-not (Test-Path -LiteralPath $providedPath)) {
            throw "makensis.exe was not found at $providedPath"
        }
        return (Resolve-Path -LiteralPath $providedPath).Path
    }

    $installed = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($installed) {
        return $installed.Source
    }

    $toolsPath = Join-Path $repoPath 'output/tools'
    $installPath = Join-Path $toolsPath "nsis-$nsiVersion"
    $found = Get-ChildItem -LiteralPath $installPath -Recurse -Filter makensis.exe -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName -split '[\\/]' | Measure-Object | Select-Object -ExpandProperty Count } |
        Select-Object -First 1
    if ($found) {
        return $found.FullName
    }

    New-Item -ItemType Directory -Force -Path $toolsPath | Out-Null
    $zipPath = Join-Path $toolsPath "nsis-$nsiVersion.zip"
    $downloadRequired = $true
    if (Test-Path -LiteralPath $zipPath) {
        $currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
        $downloadRequired = $currentHash -ne $nsiSha256
    }
    if ($downloadRequired) {
        Write-Host "Downloading NSIS $nsiVersion..."
        Invoke-WebRequest -Uri $nsiUrl -OutFile $zipPath -MaximumRedirection 10 -UseBasicParsing

        # SourceForge can return an HTML redirect page for direct downloads.
        $downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
        if ($downloadedHash -ne $nsiSha256) {
            $html = Get-Content -LiteralPath $zipPath -Raw
            $redirect = [regex]::Match($html, 'content="5; url=([^"]+)"')
            if (-not $redirect.Success) {
                throw 'NSIS download returned unexpected content and no mirror URL was found.'
            }
            $mirrorUrl = [System.Net.WebUtility]::HtmlDecode($redirect.Groups[1].Value)
            Invoke-WebRequest -Uri $mirrorUrl -OutFile $zipPath -MaximumRedirection 10 -UseBasicParsing
        }

        $downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
        if ($downloadedHash -ne $nsiSha256) {
            throw "NSIS download failed SHA-256 verification. Expected $nsiSha256, got $downloadedHash."
        }
    }

    if (Test-Path -LiteralPath $installPath) {
        Remove-Item -LiteralPath $installPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $installPath | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $installPath -Force
    $found = Get-ChildItem -LiteralPath $installPath -Recurse -Filter makensis.exe |
        Sort-Object { $_.FullName -split '[\\/]' | Measure-Object | Select-Object -ExpandProperty Count } |
        Select-Object -First 1
    if (-not $found) {
        throw "Could not find makensis.exe in $installPath"
    }
    return $found.FullName
}

function Assert-ValidMicrosoftSignature([string]$path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $path
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Microsoft Edge WebView2 bootstrapper signature is not valid: $($signature.StatusMessage)"
    }
}

function Resolve-WebView2Bootstrapper() {
    $cachedPath = Join-Path $repoPath 'output/tools/MicrosoftEdgeWebview2Setup.exe'
    if (Test-Path -LiteralPath $cachedPath) {
        Assert-ValidMicrosoftSignature $cachedPath
        return $cachedPath
    }

    $modulePath = (& go env GOMODCACHE).Trim()
    if ($modulePath) {
        $bundledPath = Join-Path $modulePath "github.com/wailsapp/wails/v2@$wailsVersion/internal/webview2runtime/MicrosoftEdgeWebview2Setup.exe"
        if (Test-Path -LiteralPath $bundledPath) {
            Assert-ValidMicrosoftSignature $bundledPath
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cachedPath) | Out-Null
            Copy-Item -LiteralPath $bundledPath -Destination $cachedPath
            return $cachedPath
        }
    }

    Write-Host 'Downloading the Microsoft Edge WebView2 bootstrapper...'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cachedPath) | Out-Null
    Invoke-WebRequest -Uri $webView2Url -OutFile $cachedPath -MaximumRedirection 10 -UseBasicParsing
    Assert-ValidMicrosoftSignature $cachedPath
    return $cachedPath
}

function New-PortablePackage([string]$exePath) {
    $stagePath = Join-Path ([IO.Path]::GetTempPath()) "orbitssh-portable-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $stagePath | Out-Null
    try {
        Copy-Item -LiteralPath $exePath -Destination (Join-Path $stagePath 'OrbitSSH.exe')
        Copy-Item -LiteralPath (Join-Path $repoPath 'LICENSE') -Destination (Join-Path $stagePath 'LICENSE.txt')
        $readme = @"
Orbit SSH $Version · Windows x64 便携版

1. 将压缩包解压到任意可写目录。
2. 双击 OrbitSSH.exe 运行，无需安装。
3. 需要 Microsoft Edge WebView2 Runtime；Windows 11 通常已自带。

主机配置和终端历史保存在 %APPDATA%\OrbitSSH；密码和私钥口令保存在 Windows 凭据管理器。
便携版不会写入程序目录。删除解压后的文件夹即可移除程序；如需清除配置和凭据，请手动删除上述目录并在 Windows 凭据管理器中删除 OrbitSSH 条目。
"@
        [IO.File]::WriteAllText(
            (Join-Path $stagePath 'README.txt'),
            $readme,
            [System.Text.UTF8Encoding]::new($false)
        )

        $zipPath = Join-Path $outputPath "$artifactBase-portable.zip"
        if (Test-Path -LiteralPath $zipPath) {
            Remove-Item -LiteralPath $zipPath -Force
        }
        Compress-Archive -Path (Join-Path $stagePath '*') -DestinationPath $zipPath -CompressionLevel Optimal
        return Get-Item -LiteralPath $zipPath
    } finally {
        Remove-Item -LiteralPath $stagePath -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function New-InstallerPackage([string]$exePath) {
    $makensis = Resolve-Nsis $NsisPath
    $webView2 = Resolve-WebView2Bootstrapper
    $payloadPath = Join-Path $repoPath 'build/windows/installer/payload'
    $installerPath = Join-Path $repoPath 'build/windows/installer/OrbitSSH-setup.exe'
    $nsiPath = Join-Path $repoPath 'build/windows/installer/OrbitSSH.nsi'

    if (Test-Path -LiteralPath $payloadPath) {
        Remove-Item -LiteralPath $payloadPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $payloadPath | Out-Null
    Copy-Item -LiteralPath $exePath -Destination (Join-Path $payloadPath 'OrbitSSH.exe')
    Copy-Item -LiteralPath (Join-Path $repoPath 'LICENSE') -Destination (Join-Path $payloadPath 'LICENSE.txt')
    Copy-Item -LiteralPath $webView2 -Destination (Join-Path $payloadPath 'MicrosoftEdgeWebview2Setup.exe')
    if (Test-Path -LiteralPath $installerPath) {
        Remove-Item -LiteralPath $installerPath -Force
    }

    $previousNsisDir = $env:NSISDIR
    $nsisDir = Split-Path -Parent $makensis
    if ((Split-Path -Leaf $nsisDir) -eq 'Bin') {
        $nsisDir = Split-Path -Parent $nsisDir
    }
    Push-Location (Split-Path -Parent $nsiPath)
    try {
        $env:NSISDIR = $nsisDir
        Invoke-Checked $makensis @(
            '/V2',
            "/DAPP_VERSION=$Version",
            "/DVI_VERSION=$viVersion",
            (Split-Path -Leaf $nsiPath)
        )
    } finally {
        $env:NSISDIR = $previousNsisDir
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $installerPath)) {
        throw "NSIS did not produce $installerPath"
    }
    $destination = Join-Path $outputPath "$artifactBase-setup.exe"
    Move-Item -LiteralPath $installerPath -Destination $destination -Force
    return Get-Item -LiteralPath $destination
}

$Version = Resolve-ProductVersion $Version
$viVersion = Get-FourPartVersion $Version
if (-not $ReleaseLabel) {
    $ReleaseLabel = "v$Version"
}
$artifactBase = "OrbitSSH-$ReleaseLabel-windows-x64"
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoPath 'output/release'
}
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

$exePath = Join-Path $repoPath 'build/bin/OrbitSSH.exe'
if (-not $SkipBuild) {
    $buildArguments = @{ OutputName = 'OrbitSSH.exe' }
    if ($WailsPath) {
        $buildArguments.WailsPath = $WailsPath
    }
    & (Join-Path $PSScriptRoot 'build-windows.ps1') @buildArguments
}
if (-not (Test-Path -LiteralPath $exePath)) {
    throw "The application binary was not found at $exePath. Run without -SkipBuild or run scripts/build-windows.ps1 first."
}

$artifacts = @()
if (-not $InstallerOnly) {
    Write-Host 'Creating portable package...'
    $artifacts += New-PortablePackage $exePath
}
if (-not $PortableOnly) {
    Write-Host 'Creating installer...'
    $artifacts += New-InstallerPackage $exePath
}
foreach ($extra in $ExtraArtifact) {
    if (-not (Test-Path -LiteralPath $extra)) {
        throw "Extra artifact was not found: $extra"
    }
    $artifacts += Get-Item -LiteralPath (Resolve-Path -LiteralPath $extra).Path
}

$checksumPath = Join-Path $outputPath 'SHA256SUMS.txt'
$checksumLines = foreach ($artifact in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact.FullName).Hash.ToLowerInvariant()
    "$hash  $($artifact.Name)"
}
[IO.File]::WriteAllLines($checksumPath, @($checksumLines), [System.Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host 'Packaging complete:'
foreach ($artifact in $artifacts) {
    Write-Host ("  {0} ({1:N2} MB)" -f $artifact.FullName, ($artifact.Length / 1MB))
}
Write-Host "  $checksumPath"
