const isMissingBinaryError = (error) => (
  Boolean(error && typeof error === 'object' && error.code === 'ENOENT')
);

const lastNonEmptyLine = (value) => {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || '';
};

const escapeAppleScriptString = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const zenityFilename = (defaultPath) => {
  if (!defaultPath) return [];
  return ['--filename', defaultPath.endsWith('/') ? defaultPath : `${defaultPath}/`];
};

const looksLikeWindowsPath = (value) => (
  /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
);

const detectWsl = () => Boolean(
  process.env.WSL_DISTRO_NAME
  || process.env.WSL_INTEROP
);

const encodePowerShellCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

const WINDOWS_FOLDER_PICKER_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class PiChamberFolderPicker {
  [ComImport]
  [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  private class FileOpenDialog { }

  [ComImport]
  [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void GetTitle([MarshalAs(UnmanagedType.LPWStr)] out string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  [ComImport]
  [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName(
    [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
    IntPtr pbc,
    [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
    out IShellItem ppv
  );

  private const uint FOS_PICKFOLDERS = 0x00000020;
  private const uint FOS_FORCEFILESYSTEM = 0x00000040;
  private const uint FOS_NOCHANGEDIR = 0x00000008;
  private const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string Pick(string title, string initialPath) {
    var dialog = (IFileOpenDialog)new FileOpenDialog();
    dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR);
    if (!string.IsNullOrEmpty(title)) {
      dialog.SetTitle(title);
    }
    if (!string.IsNullOrEmpty(initialPath)) {
      try {
        IShellItem folder;
        SHCreateItemFromParsingName(initialPath, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
        dialog.SetFolder(folder);
      } catch {
      }
    }
    int hr = dialog.Show(IntPtr.Zero);
    if (hr != 0) {
      return null;
    }
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
"@

$path = [PiChamberFolderPicker]::Pick('Select folder', $env:PICHAMBER_FOLDER_PICKER_START)
if ([string]::IsNullOrWhiteSpace($path)) { exit 1 }
Write-Output $path
`.trim();

export const buildWindowsFolderPickerCommand = (defaultPath = '') => ({
  command: 'powershell.exe',
  args: ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', encodePowerShellCommand(WINDOWS_FOLDER_PICKER_SCRIPT)],
  env: {
    PICHAMBER_FOLDER_PICKER_START: defaultPath || '',
  },
});

export const buildDirectoryPickerCommands = (platform, defaultPath = '', options = {}) => {
  const isWsl = options.isWsl ?? detectWsl();
  const windowsPicker = buildWindowsFolderPickerCommand(defaultPath);

  if (platform === 'darwin') {
    const script = defaultPath
      ? `POSIX path of (choose folder default location POSIX file "${escapeAppleScriptString(defaultPath)}")`
      : 'POSIX path of (choose folder)';
    return [{ command: 'osascript', args: ['-e', script] }];
  }

  if (platform === 'win32') {
    return [windowsPicker];
  }

  const linuxCommands = [
    { command: 'zenity', args: ['--file-selection', '--directory', ...zenityFilename(defaultPath)] },
    { command: 'kdialog', args: ['--getexistingdirectory', defaultPath || '.'] },
  ];

  if (isWsl) {
    return [windowsPicker, ...linuxCommands];
  }

  return [...linuxCommands, windowsPicker];
};

export const runDirectoryPickerCommand = (spawn, command, args, options = {}) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : undefined,
    });
  } catch (error) {
    resolve(isMissingBinaryError(error) ? { missing: true } : { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  let stdout = '';
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.once('error', (error) => {
    finish(isMissingBinaryError(error)
      ? { missing: true }
      : { error: error instanceof Error ? error.message : String(error) });
  });
  child.once('close', (code) => {
    const pickedPath = lastNonEmptyLine(stdout);
    if (code === 0 && pickedPath) {
      finish({ path: pickedPath });
      return;
    }
    finish({ cancelled: true });
  });
});

const toHostPath = async (spawn, platform, pickedPath, runCommand) => {
  if (platform !== 'linux' || !looksLikeWindowsPath(pickedPath)) {
    return pickedPath;
  }
  const converted = await runCommand(spawn, 'wslpath', ['-u', pickedPath]);
  return converted?.path || pickedPath;
};

export const pickHostDirectory = async ({
  platform,
  spawn,
  defaultPath = '',
  isWsl = detectWsl(),
  runCommand = runDirectoryPickerCommand,
} = {}) => {
  let startPath = defaultPath;
  if (isWsl && defaultPath && !looksLikeWindowsPath(defaultPath)) {
    const converted = await runCommand(spawn, 'wslpath', ['-w', defaultPath]);
    if (converted?.path) startPath = converted.path;
  }
  const commands = buildDirectoryPickerCommands(platform, startPath, { isWsl });
  for (const candidate of commands) {
    const result = await runCommand(spawn, candidate.command, candidate.args, { env: candidate.env });
    if (result?.missing) continue;
    if (result?.path) {
      const hostPath = await toHostPath(spawn, platform, result.path, runCommand);
      return { status: 'ok', path: hostPath };
    }
    if (result?.cancelled) return { status: 'cancelled' };
    if (result?.error) return { status: 'error', error: result.error };
  }
  return { status: 'unavailable' };
};
