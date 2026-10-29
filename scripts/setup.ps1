param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [string]$ArtifactsDir
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $packageRoot 'dist/cli.js'
if (-not (Test-Path -LiteralPath $cliPath)) { throw 'Run npm ci and npm run build in the package directory first.' }
$resolvedProject = [System.IO.Path]::GetFullPath($ProjectRoot)
$configPath = Join-Path $resolvedProject 'pixso-react.config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  if ($ArtifactsDir) { & node $cliPath init --project $resolvedProject --artifacts $ArtifactsDir }
  else { & node $cliPath init --project $resolvedProject }
  if ($LASTEXITCODE -ne 0) { throw 'Configuration initialization failed.' }
}
& node $cliPath install --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'GigaCode MCP registration failed.' }
Write-Host "Ready: $configPath. Set Pixso scope and GigaCode launcher, then restart GigaCode."
