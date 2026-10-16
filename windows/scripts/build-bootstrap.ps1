$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$output = Join-Path $PSScriptRoot '../target/release/coucou-latest.exe'
New-Item -ItemType Directory -Force (Split-Path $output) | Out-Null
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll "/out:$output" (Join-Path $PSScriptRoot 'bootstrap/Latest.cs')
if ($LASTEXITCODE -ne 0) { throw 'Bootstrap installer compilation failed' }
