[CmdletBinding()]
param(
    [string]$SdkPath,
    [string]$JdkPath,
    [string]$OutputPath,
    [switch]$SkipFrontend
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoPath = Split-Path -Parent $PSScriptRoot
$buildPath = Join-Path $PSScriptRoot 'build'

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Executable" }
}

if (-not $SdkPath) {
    foreach ($candidate in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME, (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'platforms\android-35\android.jar'))) {
            $SdkPath = $candidate
            break
        }
    }
}
if (-not $SdkPath) { throw 'Android SDK Platform 35 is required. Pass -SdkPath or install it in Android Studio.' }
$androidJar = Join-Path $SdkPath 'platforms\android-35\android.jar'
$toolsPath = Get-ChildItem -LiteralPath (Join-Path $SdkPath 'build-tools') -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe')) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $toolsPath) { throw 'Android SDK Build-Tools are required.' }

if (-not $JdkPath) {
    foreach ($candidate in @((Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'), $env:JAVA_HOME)) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'bin\javac.exe'))) {
            $JdkPath = $candidate
            break
        }
    }
}
if (-not $JdkPath) { throw 'JDK 17 or 21 is required. Pass -JdkPath or install Android Studio.' }
[xml]$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Raw
$versionName = $manifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
if (-not $OutputPath) { $OutputPath = Join-Path $repoPath "build\bin\OrbitSSH-v$versionName-android-arm64.apk" }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force -Path $buildPath, (Split-Path -Parent $OutputPath) | Out-Null
$savedEnvironment = @{}
foreach ($name in @('JAVA_HOME', 'GOOS', 'GOARCH', 'CGO_ENABLED')) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

Push-Location $repoPath
try {
    $env:JAVA_HOME = $JdkPath
    if (-not $SkipFrontend) {
        Push-Location (Join-Path $repoPath 'frontend')
        try {
            if (-not (Test-Path -LiteralPath node_modules)) { Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund') }
            Invoke-Checked 'npm.cmd' @('run', 'build')
        } finally { Pop-Location }
    }

    $nativePath = Join-Path $buildPath 'native\arm64-v8a'
    New-Item -ItemType Directory -Force -Path $nativePath | Out-Null
    $env:GOOS = 'android'
    $env:GOARCH = 'arm64'
    $env:CGO_ENABLED = '0'
    Write-Host 'Building the shared SSH engine for Android ARM64...'
    Invoke-Checked 'go' @('build', '-trimpath', '-buildmode=pie', '-ldflags=-s -w', '-o', (Join-Path $nativePath 'liborbit.so'), '.')

    # Each invocation uses a fresh directory so removed assets/classes cannot
    # remain in an APK built after a source change.
    $stagePath = Join-Path $buildPath ([Guid]::NewGuid().ToString('N'))
    $classesPath = Join-Path $stagePath 'classes'
    $dexPath = Join-Path $stagePath 'dex'
    $assetsPath = Join-Path $stagePath 'assets'
    New-Item -ItemType Directory -Force -Path $classesPath, $dexPath, $assetsPath | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoPath 'frontend\dist') -Destination (Join-Path $assetsPath 'www') -Recurse
    $javaSources = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.java' -Recurse | Select-Object -ExpandProperty FullName)
    Invoke-Checked (Join-Path $JdkPath 'bin\javac.exe') (@('--release', '8', '-Xlint:-options', '-encoding', 'UTF-8', '-classpath', $androidJar, '-d', $classesPath) + $javaSources)
    $classFiles = @(Get-ChildItem -LiteralPath $classesPath -Filter '*.class' -Recurse | Select-Object -ExpandProperty FullName)
    Invoke-Checked (Join-Path $toolsPath 'd8.bat') (@('--release', '--min-api', '28', '--lib', $androidJar, '--output', $dexPath) + $classFiles)
    $resourcesPath = Join-Path $stagePath 'resources.zip'
    Invoke-Checked (Join-Path $toolsPath 'aapt2.exe') @('compile', '--dir', (Join-Path $PSScriptRoot 'res'), '-o', $resourcesPath)
    $unsignedPath = Join-Path $stagePath 'unsigned.apk'
    Invoke-Checked (Join-Path $toolsPath 'aapt2.exe') @('link', '-o', $unsignedPath, '-I', $androidJar, '--manifest', (Join-Path $PSScriptRoot 'AndroidManifest.xml'), $resourcesPath)

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $assetFiles = @(Get-ChildItem -LiteralPath $assetsPath -Recurse -File -Force | Sort-Object FullName)
    $zip = [IO.Compression.ZipFile]::Open($unsignedPath, [IO.Compression.ZipArchiveMode]::Update)
    try {
        # Windows aapt2 can put backslashes in -A asset entry names. Android's
        # AssetManager requires ZIP paths with forward slashes on every host.
        foreach ($asset in $assetFiles) {
            $entryName = 'assets/' + $asset.FullName.Substring($assetsPath.Length + 1).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $asset.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $dexPath 'classes.dex'), 'classes.dex', [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        # Android permits executing an extracted native library from this
        # read-only install directory. Application data is never executable.
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $nativePath 'liborbit.so'), 'lib/arm64-v8a/liborbit.so', [IO.Compression.CompressionLevel]::NoCompression) | Out-Null
    } finally { $zip.Dispose() }

    $alignedPath = Join-Path $stagePath 'aligned.apk'
    Invoke-Checked (Join-Path $toolsPath 'zipalign.exe') @('-P', '16', '-f', '4', $unsignedPath, $alignedPath)
    $keystorePath = Join-Path $PSScriptRoot 'orbit-local.keystore'
    if (-not (Test-Path -LiteralPath $keystorePath)) {
        Invoke-Checked (Join-Path $JdkPath 'bin\keytool.exe') @('-genkeypair', '-noprompt', '-keystore', $keystorePath, '-storepass', 'android', '-keypass', 'android', '-alias', 'orbit-local', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Orbit SSH Local Build')
    }
    Invoke-Checked (Join-Path $toolsPath 'apksigner.bat') @('sign', '--ks', $keystorePath, '--ks-key-alias', 'orbit-local', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', $OutputPath, $alignedPath)
    Invoke-Checked (Join-Path $toolsPath 'apksigner.bat') @('verify', '--verbose', $OutputPath)
    Invoke-Checked (Join-Path $toolsPath 'zipalign.exe') @('-c', '-P', '16', '4', $OutputPath)
    # Validate the delivered APK, including the exact path opened at startup.
    $apk = [IO.Compression.ZipFile]::OpenRead($OutputPath)
    try {
        foreach ($entry in $apk.Entries) {
            if ($entry.FullName.Contains('\')) { throw "Invalid APK entry path: $($entry.FullName)" }
        }
        foreach ($requiredEntry in @('AndroidManifest.xml', 'resources.arsc', 'classes.dex', 'lib/arm64-v8a/liborbit.so', 'assets/www/index.html')) {
            $entry = $apk.GetEntry($requiredEntry)
            if (-not $entry -or $entry.Length -eq 0) { throw "Missing or empty APK entry: $requiredEntry" }
        }
        foreach ($asset in $assetFiles) {
            $entryName = 'assets/' + $asset.FullName.Substring($assetsPath.Length + 1).Replace('\', '/')
            $entry = $apk.GetEntry($entryName)
            if (-not $entry -or $entry.Length -ne $asset.Length) { throw "Missing or incomplete APK asset: $entryName" }
        }
    } finally { $apk.Dispose() }
    Write-Host "Verified offline UI assets: $($assetFiles.Count) files."
    Write-Host "APK: $OutputPath"
    $apkHash = Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath
    Set-Content -LiteralPath ($OutputPath + '.sha256') -Value ($apkHash.Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($OutputPath)) -Encoding ascii
    $apkHash
} finally {
    Pop-Location
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
