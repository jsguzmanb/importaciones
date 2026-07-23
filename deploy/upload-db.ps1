# Sube daater.db al volumen persistente de la app en Fly.io.
# Requiere: flyctl instalado y autenticado (fly auth login), y la app ya desplegada
# (fly deploy) al menos una vez.
#
# Uso: correr despues de "npm run search", desde la raiz del proyecto:
#   powershell -File deploy/upload-db.ps1

$ErrorActionPreference = "Stop"

$AppName = "daater-dashboard"
$LocalDb = Join-Path $PSScriptRoot "..\daater.db"
$RemoteDb = "/data/daater.db"

if (-not (Test-Path $LocalDb)) {
    throw "No se encontro daater.db en $LocalDb. Corre 'npm run search' primero."
}

Write-Host "Asegurando que la maquina este arrancada..."
flyctl machine start -a $AppName 2>$null | Out-Null

# flyctl sftp put no sobreescribe archivos existentes, asi que hay que borrar
# el archivo remoto anterior antes de subir el nuevo.
Write-Host "Borrando daater.db anterior en el volumen..."
flyctl ssh console -a $AppName -C "rm -f $RemoteDb"

Write-Host "Subiendo daater.db nuevo a la app '$AppName' (volumen /data)..."
flyctl sftp put "$LocalDb" $RemoteDb -a $AppName

Write-Host "Listo. Reiniciando la maquina para que server.mjs relea el archivo..."
flyctl deploy -a $AppName

Write-Host "Deploy de datos completado."
