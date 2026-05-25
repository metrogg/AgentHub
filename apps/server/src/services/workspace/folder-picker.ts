import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HTTPException } from 'hono/http-exception'
import { logger } from '../../lib/logger'

const execFileAsync = promisify(execFile)

export async function pickNativeFolder(): Promise<string | null> {
  logger.info({ platform: process.platform }, 'Opening native folder picker')

  if (process.platform === 'win32') {
    const modernScript = [
      '$ErrorActionPreference = "Stop"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.TopMost = $true',
      '$owner.ShowInTaskbar = $false',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.Width = 1',
      '$owner.Height = 1',
      '$owner.Opacity = 0.01',
      '[void]$owner.Show()',
      '[void]$owner.Activate()',
      'Add-Type -TypeDefinition @\'',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class ModernFolderPicker {',
      '  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]',
      '  private class FileOpenDialog {}',
      '  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("d57c7288-d4ad-4768-be02-9d969532d960")]',
      '  private interface IFileOpenDialog {',
      '    [PreserveSig] int Show(IntPtr parent);',
      '    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);',
      '    void SetFileTypeIndex(uint iFileType);',
      '    void GetFileTypeIndex(out uint piFileType);',
      '    void Advise(IntPtr pfde, out uint pdwCookie);',
      '    void Unadvise(uint dwCookie);',
      '    void SetOptions(uint fos);',
      '    void GetOptions(out uint pfos);',
      '    void SetDefaultFolder(IntPtr psi);',
      '    void SetFolder(IntPtr psi);',
      '    void GetFolder(out IntPtr ppsi);',
      '    void GetCurrentSelection(out IntPtr ppsi);',
      '    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);',
      '    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);',
      '    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);',
      '    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);',
      '    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);',
      '    void GetResult(out IShellItem ppsi);',
      '    void AddPlace(IntPtr psi, int fdap);',
      '    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);',
      '    void Close(int hr);',
      '    void SetClientGuid(ref Guid guid);',
      '    void ClearClientData();',
      '    void SetFilter(IntPtr pFilter);',
      '  }',
      '  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]',
      '  private interface IShellItem {',
      '    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);',
      '    void GetParent(out IShellItem ppsi);',
      '    void GetDisplayName(uint sigdnName, out IntPtr ppszName);',
      '    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);',
      '    void Compare(IShellItem psi, uint hint, out int piOrder);',
      '  }',
      '  public static string Pick(IntPtr owner) {',
      '    const uint FOS_PICKFOLDERS = 0x20;',
      '    const uint FOS_FORCEFILESYSTEM = 0x40;',
      '    const uint FOS_NOCHANGEDIR = 0x8;',
      '    const uint FOS_PATHMUSTEXIST = 0x800;',
      '    const uint SIGDN_FILESYSPATH = 0x80058000;',
      '    var dialog = (IFileOpenDialog)new FileOpenDialog();',
      '    try {',
      '      dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST);',
      '      dialog.SetTitle("选择项目文件夹");',
      '      dialog.SetOkButtonLabel("打开文件夹");',
      '      if (dialog.Show(owner) != 0) return null;',
      '      IShellItem item;',
      '      dialog.GetResult(out item);',
      '      IntPtr pathPtr;',
      '      item.GetDisplayName(SIGDN_FILESYSPATH, out pathPtr);',
      '      try { return Marshal.PtrToStringUni(pathPtr); }',
      '      finally { Marshal.FreeCoTaskMem(pathPtr); if (item != null) Marshal.ReleaseComObject(item); }',
      '    } finally { if (dialog != null) Marshal.ReleaseComObject(dialog); }',
      '  }',
      '}',
      '\'@',
      'try { [ModernFolderPicker]::Pick($owner.Handle) } finally { $owner.Close(); $owner.Dispose() }',
    ].join('\n')
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', modernScript], {
        windowsHide: false,
      })
      const path = stdout.trim() || null
      logger.info({ path }, 'Windows folder picker returned')
      return path
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Windows folder picker failed')
      throw err
    }
  }

  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "选择项目文件夹")'
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script])
      return stdout.trim() || null
    } catch (err) {
      if (typeof err === 'object' && err && 'code' in err && err.code === 1) return null
      throw err
    }
  }

  try {
    const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=选择项目文件夹'])
    return stdout.trim() || null
  } catch (err) {
    if (typeof err === 'object' && err && 'code' in err && err.code === 1) return null
    throw new HTTPException(501, { message: '当前环境没有可用的本机文件夹选择器' })
  }
}
