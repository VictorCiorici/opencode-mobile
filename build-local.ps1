<param>(
    [switch]$Strace,
    [switch]$Install,
    [string]$Device = "RFCW615ZQSZ"
)

$ErrorActionPreference = "Stop"

# ---- tool locations ----
$go       = "C:\Program Files\Go\bin\go.exe"
$gradle   = "C:\Tools\gradle-8.5\bin\gradle.bat"
$sevenzip = "C:\Program Files\7-Zip\7z.exe"
$adb      = "C:\Unity_Android_SDK\platform-tools\adb.exe"
$sdk      = "C:\Unity_Android_SDK"
$root     = $PSScriptRoot
$android  = Join-Path $root "android"
$daemon   = Join-Path $root "daemon"

$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# write local.properties so AGP finds the SDK
Set-Content -Path (Join-Path $android "local.properties") -Value "sdk.dir=$sdk".Replace('\','\\')

$tmp = Join-Path $env:TEMP "ocmb-build"
$rt = Join-Path $tmp "rt"
Remove-Item -Recurse -Force $rt -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $rt, (Join-Path $rt "bin"), (Join-Path $rt "lib") | Out-Null

# ---------------------------------------------------------------- 1. daemon
Write-Host "`n==> Building ARM64 daemon (libdaemon.so)" -ForegroundColor Cyan
Push-Location $daemon
try {
    $env:CGO_ENABLED = "0"; $env:GOOS = "linux"; $env:GOARCH = "arm64"
    & $go vet ./... 2>&1 | Write-Host
    & $go test ./... 2>&1 | Write-Host
    $jni = Join-Path $android "app\src\main\jniLibs\arm64-v8a"
    New-Item -ItemType Directory -Force -Path $jni | Out-Null
    & $go build -ldflags="-s -w" -o (Join-Path $jni "libdaemon.so") .
    if ($LASTEXITCODE -ne 0) { throw "go build failed" }
    $assetsBin = Join-Path $android "app\src\main\assets\bin"
    New-Item -ItemType Directory -Force -Path $assetsBin | Out-Null
    Copy-Item (Join-Path $jni "libdaemon.so") (Join-Path $assetsBin "openforge-daemon")
    Write-Host "    daemon -> $jni\libdaemon.so"
} finally { Pop-Location }

# ---------------------------------------------------------------- 2. engine
Write-Host "`n==> Downloading opencode engine (linux/arm64, musl)" -ForegroundColor Cyan
# musl build: musl never calls set_robust_list(99)/rseq(293)/clone3(435),
# which Android's app seccomp policy SIGSYS-kills (RET_KILL outranks any
# ERRNO shim, so glibc builds cannot run at all).
$ocTar = Join-Path $tmp "oc.tar.gz"
curl.exe -fsSL https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-arm64-musl.tar.gz -o $ocTar
$ocDir = Join-Path $tmp "oc"
Remove-Item -Recurse -Force $ocDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $ocDir | Out-Null
tar -xzf $ocTar -C $ocDir
$engine = Get-ChildItem $ocDir -Recurse -Filter opencode -File | Select-Object -First 1
if (-not $engine) { throw "opencode binary not found in archive" }
Copy-Item $engine.FullName (Join-Path $rt "bin\opencode")
Write-Host "    engine -> $($engine.FullName)"

# ---------------------------------------------------------------- 3. musl runtime (Alpine)
Write-Host "`n==> Downloading musl runtime (Alpine aarch64)" -ForegroundColor Cyan
$alpine = "https://dl-cdn.alpinelinux.org/alpine/v3.19/main/aarch64"
$muslPkgs = @(
    @{ apk = "musl-1.2.4_git20230717-r6.apk"; files = @("ld-musl-aarch64.so.1") },
    @{ apk = "libstdc++-13.2.1_git20231014-r0.apk"; files = @("libstdc++.so.6") },
    @{ apk = "libgcc-13.2.1_git20231014-r0.apk"; files = @("libgcc_s.so.1") }
)
foreach ($p in $muslPkgs) {
    $apkPath = Join-Path $tmp ($p.apk -replace '\+','plus')
    curl.exe -fsSL "$alpine/$($p.apk)" -o $apkPath
    $ax = Join-Path $tmp ($p.apk + ".x")
    Remove-Item -Recurse -Force $ax -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $ax | Out-Null
    tar -xzf $apkPath -C $ax
    foreach ($name in $p.files) {
        $f = Get-ChildItem $ax -Recurse -Filter $name -File | Select-Object -First 1
        if (-not $f) { throw "$name not found in $($p.apk)" }
        Copy-Item $f.FullName (Join-Path $rt "bin\$($f.Name)") -Force
        Write-Host "    $($f.Name) -> $($f.Length) bytes"
    }
}
Write-Host "    musl runtime -> $rt\bin"

# ---------------------------------------------------------------- 4. strace (opt)
if ($Strace) {
    Write-Host "`n==> Bundling strace (Termux aarch64) for syscall tracing" -ForegroundColor Cyan
    try {
        $tp = Invoke-WebRequest -UseBasicParsing "https://packages.termux.org/apt/termux-main/pool/main/s/strace/"
        $straceDeb = ($tp.Content | Select-String -Pattern 'strace_[^"]*_aarch64\.deb' -AllMatches |
                      ForEach-Object { $_.Matches.Value }) | Select-Object -First 1
        if ($straceDeb) {
            $sdeb = Join-Path $tmp "strace.deb"
            curl.exe -fsSL "https://packages.termux.org/apt/termux-main/pool/main/s/strace/$straceDeb" -o $sdeb
            $sx = Join-Path $tmp "straceX"
            Remove-Item -Recurse -Force $sx -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force -Path $sx | Out-Null
            & $sevenzip x $sdeb "-o$sx" -y | Out-Null
            $sbin = Get-ChildItem $sx -Recurse -Filter strace -File | Select-Object -First 1
            if ($sbin) { Copy-Item $sbin.FullName (Join-Path $rt "bin\strace"); Write-Host "    strace -> $($sbin.FullName)" }
        } else { Write-Host "    (strace deb not found, skipping)" -ForegroundColor Yellow }
    } catch { Write-Host "    strace bundling failed: $_" -ForegroundColor Yellow }
}

# ---------------------------------------------------------------- 5. zip runtime
Write-Host "`n==> Zipping runtime-arm64.zip" -ForegroundColor Cyan
$rtZip = Join-Path $android "app\src\main\assets\runtime-arm64.zip"
Remove-Item -Force $rtZip -ErrorAction SilentlyContinue
Push-Location $rt
& $sevenzip a -tzip $rtZip * | Out-Null
Pop-Location
Write-Host "    $((Get-Item $rtZip).Length) bytes"

# ---------------------------------------------------------------- 6. PWA assets
Write-Host "`n==> Copying PWA assets" -ForegroundColor Cyan
$web = Join-Path $android "app\src\main\assets\web"
Remove-Item -Recurse -Force $web -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $web | Out-Null
Copy-Item (Join-Path $root "pwa\*") $web -Recurse
Write-Host "    pwa -> $web"

# ---------------------------------------------------------------- 7. gradle build
Write-Host "`n==> gradle assembleDebug" -ForegroundColor Cyan
Push-Location $android
try {
    # Write gradle output to a file (not a pipe to gradle) to avoid the
    # stdout-pipe deadlock that blocks the daemon build.
    $gradleLog = Join-Path $tmp "gradle.log"
    & $gradle assembleDebug --stacktrace *> $gradleLog
    $gcode = $LASTEXITCODE
    Get-Content $gradleLog -Tail 30 | Write-Host
    if ($gcode -ne 0) { throw "gradle build failed (see $gradleLog)" }
} finally { Pop-Location }

$apk = Get-ChildItem (Join-Path $android "app\build\outputs\apk\debug") -Filter *.apk | Select-Object -First 1
Write-Host "`n==> APK: $($apk.FullName)" -ForegroundColor Green

# ---------------------------------------------------------------- 8. install
if ($Install) {
    Write-Host "`n==> adb install -r on $Device" -ForegroundColor Cyan
    & $adb -s $Device install -r $apk.FullName
    & $adb -s $Device forward tcp:8787 tcp:8787
    & $adb -s $Device shell am start -n com.openforge/.MainActivity
}
