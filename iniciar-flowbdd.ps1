$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    throw 'No se encontró Node.js. Instala Node.js LTS y vuelve a abrir PowerShell.'
}

function Test-PortAvailable([int] $Port) {
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try {
        $Listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        $Listener.Stop()
    }
}

$Port = 4175
while (-not (Test-PortAvailable $Port)) {
    $Port++
    if ($Port -gt 4200) { throw 'No hay puertos disponibles entre 4175 y 4200.' }
}

Set-Location -LiteralPath $ProjectRoot
$env:PORT = [string]$Port
Write-Host "FlowBDD está disponible en http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host 'Deja esta ventana abierta mientras uses FlowBDD. Presiona Ctrl+C para detenerlo.'
try {
    & $NodeCommand.Source (Join-Path $ProjectRoot 'server.js')
} finally {
    Remove-Item Env:PORT -ErrorAction SilentlyContinue
}
