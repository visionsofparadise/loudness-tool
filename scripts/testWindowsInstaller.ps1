# Installs, reinstalls, moves, runs and uninstalls the Windows installer in the disposable GitHub-hosted CI account, and writes
# the observations to .scratch/installer/report.json. Adapted from the credact installer test.
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedExecutablePath,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CI -ne 'true' -or $env:GITHUB_ACTIONS -ne 'true' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:GITHUB_REPOSITORY -ne 'visionsofparadise/loudness-tool' -or
    $env:GITHUB_RUN_ID -notmatch '^\d+$' -or -not $env:RUNNER_TEMP) {
    throw 'Installer tests require the disposable GitHub-hosted Windows CI account.'
}

$projectDirectory = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$workspaceDirectory = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
if ($projectDirectory.TrimEnd('\') -ne $workspaceDirectory.TrimEnd('\') -or
    $env:USERPROFILE -eq 'C:\Users\mttcv') {
    throw 'Installer tests refuse a local checkout or personal account.'
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$expectedExecutable = (Resolve-Path -LiteralPath $ExpectedExecutablePath).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'loudness-tool'
$installedExecutable = Join-Path $installDirectory 'loudness-tool.exe'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\loudness-tool'
$evidenceDirectory = Join-Path $projectDirectory '.scratch/installer'
$observations = [Collections.Generic.List[object]]::new()
$processes = [Collections.Generic.List[object]]::new()

$report = [ordered]@{
    sourceCommit = $env:GITHUB_SHA
    installer = $installer
    installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    expectedExecutableHash = (Get-FileHash -LiteralPath $expectedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    installDirectory = $installDirectory
    platform = [Environment]::OSVersion.VersionString
    method = 'Native silent install, reinstall of the same version, reinstall and uninstall over a locked executable, install to another folder, PATH resolution from a fresh shell, and silent uninstall in a disposable CI account'
    observations = $observations
    processes = $processes
}

function Assert-Condition([bool]$Condition, [string]$Name) {
    $observations.Add(@{ name = $Name; passed = $Condition })
    if (-not $Condition) { throw $Name }
}

function Get-RawUserPathEntries {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    try {
        $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    } finally {
        $key.Close()
    }
    return @($value -split ';' | Where-Object { $_ })
}

function Invoke-Installer([string]$Path, [string[]]$Arguments, [int]$ExpectedExitCode = 0) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(180000)) {
        throw "Installer process $($process.Id) exceeded the three-minute limit."
    }
    $process.Refresh()
    $processes.Add(@{ executable = $Path; arguments = $Arguments; exitCode = $process.ExitCode })
    Assert-Condition ($process.ExitCode -eq $ExpectedExitCode) "Installer exits $ExpectedExitCode`: $([IO.Path]::GetFileName($Path)) $($Arguments -join ' ')"
}

function Get-PathCount([string]$Directory) {
    return @(Get-RawUserPathEntries | Where-Object { $_ -eq $Directory }).Count
}

function Invoke-FromFreshPath([string]$Command) {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $previousPath = $env:Path
    try {
        $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
        $output = (& pwsh -NoProfile -Command $Command 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    } finally {
        $env:Path = $previousPath
    }
    $processes.Add(@{ executable = "pwsh -NoProfile -Command `"$Command`""; exitCode = $exitCode; output = $output })
    return @{ output = $output; exitCode = $exitCode }
}

[void](New-Item -ItemType Directory -Path $evidenceDirectory -Force)

try {
    Assert-Condition (-not (Test-Path -LiteralPath $uninstallKey)) 'Account carries no existing loudness-tool registration'

    Invoke-Installer $installer @('/S')

    Assert-Condition (Test-Path -LiteralPath $uninstallKey) 'Silent install creates the uninstall entry'
    Assert-Condition ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -eq $ExpectedVersion) 'The uninstall entry names the version'

    $installedHash = (Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $report.installedExecutableHash = $installedHash
    Assert-Condition ($installedHash -eq $report.expectedExecutableHash) 'Installed executable matches the built binary'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $installDirectory 'THIRD-PARTY-NOTICES.txt')) 'Install carries the third-party notices'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $installDirectory 'LICENSE.txt')) 'Install carries the licence'

    $report.userPathAfterInstall = Get-RawUserPathEntries
    Assert-Condition ((Get-PathCount $installDirectory) -eq 1) 'Install adds the install directory to the raw user PATH once'

    $version = Invoke-FromFreshPath 'loudness-tool --version'
    $report.versionOutput = $version.output
    Assert-Condition ($version.exitCode -eq 0) 'A fresh shell resolves loudness-tool from the user PATH and runs it'
    Assert-Condition ($version.output.Trim() -eq $ExpectedVersion) 'The resolved loudness-tool prints the built version'

    Invoke-Installer $installer @('/S')

    $report.userPathAfterReinstall = Get-RawUserPathEntries
    Assert-Condition ((Get-PathCount $installDirectory) -eq 1) 'Reinstalling keeps a single user PATH entry'
    Assert-Condition ((Invoke-FromFreshPath 'loudness-tool --version').exitCode -eq 0) 'loudness-tool runs after reinstalling'

    $lock = [IO.File]::Open($installedExecutable, 'Open', 'Read', 'None')
    try {
        Invoke-Installer $installer @('/S') 2
    } finally {
        $lock.Close()
    }
    Assert-Condition ((Get-FileHash -LiteralPath $installedExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -eq $installedHash) 'A locked executable stays as it was'
    Assert-Condition ((Get-PathCount $installDirectory) -eq 1) 'A failed write leaves the user PATH entry in place'

    $movedDirectory = Join-Path $env:LOCALAPPDATA 'loudness-tool-moved'
    Invoke-Installer $installer @('/S', "/D=$movedDirectory")

    $report.userPathAfterMove = Get-RawUserPathEntries
    Assert-Condition (-not (Test-Path -LiteralPath $installedExecutable)) 'Installing to another folder removes the previous executable'
    Assert-Condition ((Get-PathCount $installDirectory) -eq 0) 'Installing to another folder removes the previous user PATH entry'
    Assert-Condition ((Get-PathCount $movedDirectory) -eq 1) 'Installing to another folder adds it to the user PATH once'
    Assert-Condition ((Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation -eq $movedDirectory) 'The uninstall entry names the new folder'
    $moved = Invoke-FromFreshPath 'loudness-tool --version'
    Assert-Condition ($moved.exitCode -eq 0 -and $moved.output.Trim() -eq $ExpectedVersion) 'loudness-tool runs from the new folder'

    $uninstallerCopy = Join-Path $env:RUNNER_TEMP 'loudness-tool-uninstall.exe'
    Copy-Item -LiteralPath (Join-Path $movedDirectory 'uninstall.exe') -Destination $uninstallerCopy

    $lock = [IO.File]::Open((Join-Path $movedDirectory 'loudness-tool.exe'), 'Open', 'Read', 'None')
    try {
        Invoke-Installer $uninstallerCopy @('/S', "_?=$movedDirectory") 2
    } finally {
        $lock.Close()
    }
    Assert-Condition (Test-Path -LiteralPath $uninstallKey) 'Uninstalling over a locked executable keeps the registration'
    Assert-Condition ((Get-PathCount $movedDirectory) -eq 1) 'Uninstalling over a locked executable keeps the user PATH entry'

    Invoke-Installer $uninstallerCopy @('/S', "_?=$movedDirectory")

    $report.userPathAfterUninstall = Get-RawUserPathEntries
    Assert-Condition (-not (Test-Path -LiteralPath $uninstallKey)) 'Uninstall removes the uninstall entry'
    Assert-Condition (-not (Test-Path -LiteralPath 'HKCU:\Software\loudness-tool')) 'Uninstall removes the install-location key'
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $movedDirectory 'loudness-tool.exe'))) 'Uninstall removes the executable'
    Assert-Condition ((Get-PathCount $movedDirectory) -eq 0) 'Uninstall removes the install directory from the raw user PATH'

    $report.passed = $true
} catch {
    $report.passed = $false
    $report.error = $_.Exception.Message
    throw
} finally {
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'report.json') -Encoding utf8
}
