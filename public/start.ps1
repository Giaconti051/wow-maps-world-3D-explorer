$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$browserDataRoot = Join-Path $root "WoW_Archaeology_BrowserData"
$diskCacheRoot = Join-Path $browserDataRoot "DiskCache"
$viewerUrl = "http://localhost:4173/"

New-Item -ItemType Directory -Force -Path $browserDataRoot | Out-Null
New-Item -ItemType Directory -Force -Path $diskCacheRoot | Out-Null

$edgeCandidates = @()
$edgeCommand = Get-Command "msedge.exe" -ErrorAction SilentlyContinue
if ($null -ne $edgeCommand) {
    $edgeCandidates += $edgeCommand.Source
}
$edgeCandidates += @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)
$edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($null -eq $edgePath) {
    throw "Microsoft Edge non trovato. Installa Edge oppure modifica start.ps1 indicando il percorso di msedge.exe."
}

$existingConnection = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($null -ne $existingConnection) {
    $existingPid = $existingConnection.OwningProcess
    $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $processName = if ($null -ne $existingProcess) { $existingProcess.ProcessName } else { "processo sconosciuto" }

    Write-Host "La porta 4173 e gia occupata dal processo $processName (PID $existingPid)." -ForegroundColor Yellow
    Write-Host "Probabilmente e rimasta aperta una precedente istanza di World of Warcraft Maps and World 3D Explorer."
    $choice = Read-Host "Vuoi chiuderla e avviare questa versione? Digita S per confermare"

    if ($choice -notin @("S", "s")) {
        Write-Host "Avvio annullato. La precedente istanza non e stata modificata."
        exit 1
    }

    Stop-Process -Id $existingPid -Force
    Start-Sleep -Milliseconds 500
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($viewerUrl)
$listener.Start()

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".wasm" = "application/wasm"
    ".png"  = "image/png"
    ".svg"  = "image/svg+xml"
    ".css"  = "text/css; charset=utf-8"
}

$edgeArguments = @(
    "--user-data-dir=`"$browserDataRoot`"",
    "--disk-cache-dir=`"$diskCacheRoot`"",
    "--no-first-run",
    "--disable-default-apps",
    $viewerUrl
)
Start-Process -FilePath $edgePath -ArgumentList $edgeArguments
Write-Host "World of Warcraft Maps and World 3D Explorer is running at $viewerUrl"
Write-Host "Edge data and map cache: $browserDataRoot" -ForegroundColor Cyan
Write-Host "Keep this window open. Press Ctrl+C to stop it."

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $relativePath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
        if ([string]::IsNullOrWhiteSpace($relativePath)) {
            $relativePath = "index.html"
        }

        $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))
        if (-not $filePath.StartsWith($root) -or -not [System.IO.File]::Exists($filePath)) {
            $context.Response.StatusCode = 404
            $context.Response.Close()
            continue
        }

        $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
        $context.Response.ContentType = if ($mimeTypes.ContainsKey($extension)) { $mimeTypes[$extension] } else { "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.Close()
    }
}
finally {
    $listener.Stop()
    $listener.Close()
}
