param(
  [Parameter(Mandatory=$true)][ValidateSet('state','normal','maximize')][string]$Mode,
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [int]$Left=40,[int]$Top=40,[int]$Width=1000,[int]$Height=700
)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class R141Window {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Placement {
    public int Length,Flags,ShowCmd; public Point MinPosition,MaxPosition; public Rect NormalPosition;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo {
    public int Size; public Rect Monitor,Work; public uint Flags;
  }
  public delegate bool EnumWindowsProc(IntPtr hwnd,IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback,IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowPlacement(IntPtr hwnd,ref Placement placement);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd,uint flags);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int width,int height,uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  public static IntPtr Find(uint target) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((hwnd,state)=>{uint owner;GetWindowThreadProcessId(hwnd,out owner);
      if(owner==target&&IsWindowVisible(hwnd)){found=hwnd;return false;}return true;
    },IntPtr.Zero);
    return found;
  }
}
'@
$owner=Get-Process -Id $ProcessId -ErrorAction Stop
if ($owner.ProcessName -ne 'klipper-farm-client') { throw 'Refusing to operate on another application process' }
$handle=[R141Window]::Find([uint32]$ProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'Installed Klipper Farm main window is not visible' }
if ($Mode -eq 'normal') {
  [void][R141Window]::ShowWindow($handle,9)
  if (-not [R141Window]::SetWindowPos($handle,[IntPtr]::Zero,$Left,$Top,$Width,$Height,4)) { throw 'Win32 SetWindowPos failed' }
  [void][R141Window]::SetForegroundWindow($handle)
} elseif ($Mode -eq 'maximize') {
  [void][R141Window]::ShowWindow($handle,3)
  [void][R141Window]::SetForegroundWindow($handle)
}
$rect=New-Object R141Window+Rect
if (-not [R141Window]::GetWindowRect($handle,[ref]$rect)) { throw 'GetWindowRect failed' }
$placement=New-Object R141Window+Placement
$placement.Length=[Runtime.InteropServices.Marshal]::SizeOf($placement)
if (-not [R141Window]::GetWindowPlacement($handle,[ref]$placement)) { throw 'GetWindowPlacement failed' }
$monitor=New-Object R141Window+MonitorInfo
$monitor.Size=[Runtime.InteropServices.Marshal]::SizeOf($monitor)
if (-not [R141Window]::GetMonitorInfo([R141Window]::MonitorFromWindow($handle,2),[ref]$monitor)) { throw 'GetMonitorInfo failed' }
function Rect-Object($value) { return @{left=$value.Left;top=$value.Top;right=$value.Right;bottom=$value.Bottom;width=($value.Right-$value.Left);height=($value.Bottom-$value.Top)} }
@{
  processId=$ProcessId;processName=$owner.ProcessName;windowHandle=$handle.ToInt64().ToString();
  mode=$Mode;isZoomed=[R141Window]::IsZoomed($handle);isIconic=[R141Window]::IsIconic($handle);
  bounds=(Rect-Object $rect);normalBounds=(Rect-Object $placement.NormalPosition);showCommand=$placement.ShowCmd;
  monitor=(Rect-Object $monitor.Monitor);workArea=(Rect-Object $monitor.Work)
} | ConvertTo-Json -Depth 6 -Compress
