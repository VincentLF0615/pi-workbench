# Capture the Pi Workbench window so we can see what the frontend rendered.
$out = "C:\Users\LuoFeng\pi-workbench-window.png"

$p = Get-Process -Name "pi-workbench" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) {
    Write-Output "app not running"
    exit 1
}
$handle = $p.MainWindowHandle
if ($handle -eq 0) {
    Write-Output "no main window"
    exit 1
}

# Bring the window forward, then read its rectangle.
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig
[Win32]::ShowWindow($handle, 9) | Out-Null
[Win32]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Seconds 2

$rect = New-Object Win32+RECT
[Win32]::GetWindowRect($handle, [ref] $rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output "window $width x $height at $($rect.Left),$($rect.Top)"

$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$graphics.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $out"
