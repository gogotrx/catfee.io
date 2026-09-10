[CmdletBinding()]
param(
  [string]$OutputDirectory = "",
  [string]$ReleaseId = (Get-Date -Format "yyyyMMdd-HHmmss")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-NormalizedPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

function Test-DescendantPath([string]$Path, [string]$Parent) {
  $prefix = $Parent + [System.IO.Path]::DirectorySeparatorChar
  return $Path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Read-Utf8Text([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8Text([string]$Path, [string]$Content) {
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8WithoutBom)
}

if ($ReleaseId -notmatch '^[A-Za-z0-9._-]+$') {
  throw "ReleaseId may contain only letters, digits, dot, underscore, and hyphen."
}

$sourceRoot = Get-NormalizedPath (Split-Path -Parent $PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path (Split-Path -Parent $sourceRoot) "tron-seamless-release"
}
$outputRoot = Get-NormalizedPath $OutputDirectory

if ($outputRoot -eq $sourceRoot -or (Test-DescendantPath $outputRoot $sourceRoot)) {
  throw "OutputDirectory must be outside the source workspace."
}

$packageName = "tron-seamless-gateway-sanitized-$ReleaseId"
$stagingRoot = Get-NormalizedPath (Join-Path $outputRoot ("." + $packageName + ".staging"))
$packageRoot = Join-Path $stagingRoot "tron-seamless-gateway"
$archivePath = Get-NormalizedPath (Join-Path $outputRoot ($packageName + ".zip"))
$checksumPath = Get-NormalizedPath (Join-Path $outputRoot ($packageName + ".sha256"))

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

foreach ($target in @($stagingRoot, $archivePath, $checksumPath)) {
  if (-not (Test-DescendantPath $target $outputRoot)) {
    throw "Refusing to remove a target outside OutputDirectory: $target"
  }
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}

New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

$rootFiles = @(
  ".env.example",
  ".gitignore",
  "docker-compose.dev.yml",
  "package-lock.json",
  "package.json",
  "README.md",
  "tsconfig.json",
  "tsconfig.test.json"
)
$sourceDirectories = @("deploy", "docs", "proto", "sql", "src", "test", "web")

foreach ($relativePath in $rootFiles) {
  $sourcePath = Join-Path $sourceRoot $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Required source file is missing: $relativePath"
  }
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $packageRoot $relativePath)
}

foreach ($relativePath in $sourceDirectories) {
  $sourcePath = Join-Path $sourceRoot $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "Required source directory is missing: $relativePath"
  }
  Copy-Item -LiteralPath $sourcePath -Destination $packageRoot -Recurse
}

New-Item -ItemType Directory -Path (Join-Path $packageRoot "scripts") -Force | Out-Null
Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $packageRoot "scripts\build-sanitized-package.ps1")

# Discover the deployment-specific topology from the operational runbook instead
# of embedding any real address in this packaging script.
$sourceRunbookPath = Join-Path $sourceRoot "docs\lan-runbook.md"
$sourceRunbook = Read-Utf8Text $sourceRunbookPath
$fullNodeMatch = [regex]::Match($sourceRunbook, '(?m)^.*FullNode.*?`(?<value>(?:\d{1,3}\.){3}\d{1,3})`')
$gatewayMatch = [regex]::Match($sourceRunbook, '(?m)^.*VPS.*?`(?<value>(?:\d{1,3}\.){3}\d{1,3})`')
$cidrMatch = [regex]::Match($sourceRunbook, '(?m)^.*?`(?<value>(?:\d{1,3}\.){3}\d{1,3}/\d{1,2})`')

$topologyReplacements = [ordered]@{}
if ($fullNodeMatch.Success) { $topologyReplacements[$fullNodeMatch.Groups['value'].Value] = '{FULLNODE_IP}' }
if ($gatewayMatch.Success) { $topologyReplacements[$gatewayMatch.Groups['value'].Value] = '{GATEWAY_IP}' }
if ($cidrMatch.Success) { $topologyReplacements[$cidrMatch.Groups['value'].Value] = '{TRUSTED_LAN_CIDR}' }

foreach ($markdownFile in Get-ChildItem -LiteralPath $packageRoot -Recurse -File -Filter "*.md") {
  $content = Read-Utf8Text $markdownFile.FullName
  foreach ($entry in $topologyReplacements.GetEnumerator()) {
    $content = $content.Replace([string]$entry.Key, [string]$entry.Value)
  }
  $content = [regex]::Replace($content, '(?<![A-Za-z0-9_])root@', '{SSH_USER}@')
  $content = [regex]::Replace($content, '(?<!\d)192\.168\.\d{1,3}\.\d{1,3}(?:/\d{1,2})?', '{PRIVATE_LAN_ADDRESS}')
  Write-Utf8Text $markdownFile.FullName $content
}

# Environment examples must remain syntactically valid, so use explicit sample
# addresses rather than brace placeholders.
foreach ($environmentExample in @(
  (Join-Path $packageRoot ".env.example"),
  (Join-Path $packageRoot "deploy\gateway.env.example")
)) {
  $content = Read-Utf8Text $environmentExample
  $content = [regex]::Replace($content, 'http://192\.168\.\d{1,3}\.\d{1,3}', 'http://10.0.0.10')
  Write-Utf8Text $environmentExample $content
}

$firewallExample = Join-Path $packageRoot "deploy\ufw-lan.example"
$firewallContent = Read-Utf8Text $firewallExample
$firewallContent = [regex]::Replace($firewallContent, '192\.168\.\d{1,3}\.\d{1,3}/\d{1,2}', '10.0.0.0/24')
Write-Utf8Text $firewallExample $firewallContent

$forbiddenFiles = Get-ChildItem -LiteralPath $packageRoot -Recurse -Force -File | Where-Object {
  ($_.Name -match '^\.env($|\.)' -and $_.Name -ne '.env.example') -or
  $_.Name -match '\.(pem|key|p12|pfx|jks|keystore|log|pid|db|sqlite|dump|bak|old|zip|7z|tar|gz)$' -or
  $_.Name -match '^(id_rsa|id_ed25519|authorized_keys|known_hosts)$'
}
if ($forbiddenFiles) {
  throw "Forbidden file entered the package: $($forbiddenFiles[0].FullName)"
}

$textExtensions = @('.ts', '.js', '.json', '.md', '.html', '.css', '.sql', '.proto', '.service', '.sh', '.ps1', '.example', '')
$textFiles = Get-ChildItem -LiteralPath $packageRoot -Recurse -Force -File | Where-Object {
  $textExtensions -contains $_.Extension.ToLowerInvariant()
}
foreach ($textFile in $textFiles) {
  $content = Read-Utf8Text $textFile.FullName
  foreach ($originalValue in $topologyReplacements.Keys) {
    if ($content.Contains([string]$originalValue)) {
      throw "Deployment-specific topology remains in: $($textFile.FullName)"
    }
  }
  if ($content -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') {
    throw "Private-key material detected in: $($textFile.FullName)"
  }
  if ($content -match '(?i)(?:C:\\Users\\[^\\\s]+|/home/[^/\s]+/\.ssh|/root/\.ssh)') {
    throw "User-specific path detected in: $($textFile.FullName)"
  }
  if ($content -match '(?<![A-Za-z0-9])[a-fA-F0-9]{64}(?![A-Za-z0-9])') {
    throw "A literal 64-hex candidate requires manual review: $($textFile.FullName)"
  }
}

$manifestPath = Join-Path $packageRoot "PACKAGE-MANIFEST.txt"
$manifestLines = @(
  "TRON Seamless Gateway - sanitized source package",
  "Release ID: $ReleaseId",
  "Generated (UTC): $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))",
  "",
  "Included: application source, web UI, SQL migrations, protobuf, tests, deployment templates, documentation, lockfile.",
  "Excluded: runtime .env files, credentials, databases, logs, dependency trees, build output, VCS metadata, backups, archives.",
  "Topology placeholders: {FULLNODE_IP}, {GATEWAY_IP}, {TRUSTED_LAN_CIDR}, {SSH_USER}.",
  "Public compatibility constants (USDT contract, provider endpoints, java-tron version pin) are intentionally retained.",
  "",
  "Files:"
)
foreach ($file in Get-ChildItem -LiteralPath $packageRoot -Recurse -Force -File | Sort-Object FullName) {
  $relativePath = $file.FullName.Substring($packageRoot.Length).TrimStart('\', '/')
  $manifestLines += $relativePath.Replace('\', '/')
}
Write-Utf8Text $manifestPath (($manifestLines -join "`n") + "`n")

Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Utf8Text $checksumPath ("$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n")

if (-not (Test-DescendantPath $stagingRoot $outputRoot)) {
  throw "Refusing to clean staging outside OutputDirectory."
}
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Output "ARCHIVE=$archivePath"
Write-Output "SHA256=$archiveHash"
Write-Output "CHECKSUM=$checksumPath"
