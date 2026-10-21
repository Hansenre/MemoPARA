# Cria os atalhos do MemoPARA na Area de Trabalho e no Menu Iniciar.
# Uso: clique com o botao direito > "Executar com o PowerShell", ou: npm run shortcut
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'MemoPARA.vbs'
$icon = Join-Path $root 'assets\memopara.ico'

# Verifica o Node.js (precisa do modulo node:sqlite, disponivel a partir do 22.13)
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e rode este script de novo.' -ForegroundColor Red
  exit 1
}
$version = [version]((& node -v).TrimStart('v'))
if ($version -lt [version]'22.13.0') {
  Write-Host "Node.js $version e antigo demais. Instale a versao LTS (22.13 ou mais recente) em https://nodejs.org." -ForegroundColor Red
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MemoPARA.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'MemoPARA.lnk')
)
foreach ($path in $targets) {
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = "`"$launcher`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = 'MemoPARA - revisao espacada com FSRS e PARA'
  $lnk.Save()
  Write-Host "Atalho criado: $path" -ForegroundColor Green
}
Write-Host ''
Write-Host "Node.js $version OK. Abra o MemoPARA pelo atalho 'MemoPARA' na Area de Trabalho."
