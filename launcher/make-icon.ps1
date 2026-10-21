# Gera assets\memopara.ico (PNG embutido, 256/48/32/16 px) desenhando o logo com System.Drawing.
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'assets\memopara.ico'

function New-LogoPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 64.0
  $r = 16 * $s
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($size - 2 * $r - 1, 0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($size - 2 * $r - 1, $size - 2 * $r - 1, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc(0, $size - 2 * $r - 1, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(42, 120, 214))), $path)
  $white = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (5 * $s)
  $white.StartCap = 'Round'; $white.EndCap = 'Round'; $white.LineJoin = 'Round'
  $pts = @(@(14, 44), @(14, 22), @(23, 34), @(32, 22), @(32, 44)) | ForEach-Object { New-Object System.Drawing.PointF ($_[0] * $s), ($_[1] * $s) }
  $g.DrawLines($white, [System.Drawing.PointF[]]$pts)
  $light = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(183, 211, 246)), (5 * $s)
  $light.StartCap = 'Round'; $light.EndCap = 'Round'
  $g.DrawBezier($light, 38 * $s, 44 * $s, 41 * $s, 33 * $s, 45 * $s, 25 * $s, 50 * $s, 22 * $s)
  $g.FillEllipse([System.Drawing.Brushes]::White, 46 * $s, 18 * $s, 8 * $s, 8 * $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

$sizes = 256, 48, 32, 16
$images = $sizes | ForEach-Object { ,(New-LogoPng $_) }
$fs = [System.IO.File]::Create($out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write($img) }
$w.Close()
Write-Host "Icone gerado: $out"
