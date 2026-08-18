import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDirectoryPickerCommands,
  pickHostDirectory,
  runDirectoryPickerCommand,
} from './pick-directory.js';

const createChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
};

describe('buildDirectoryPickerCommands', () => {
  it('uses osascript on macOS', () => {
    const commands = buildDirectoryPickerCommands('darwin', '/Users/ryder/Projects');
    expect(commands).toEqual([
      {
        command: 'osascript',
        args: ['-e', 'POSIX path of (choose folder default location POSIX file "/Users/ryder/Projects")'],
      },
    ]);
  });

  it('tries zenity, kdialog, then Windows PowerShell on Linux', () => {
    const commands = buildDirectoryPickerCommands('linux', '/home/ryder', { isWsl: false });
    expect(commands.map((entry) => entry.command)).toEqual(['zenity', 'kdialog', 'powershell.exe']);
    expect(commands[0].args).toEqual(['--file-selection', '--directory', '--filename', '/home/ryder/']);
    expect(commands[2].args).toContain('-EncodedCommand');
    expect(commands[2].args.join(' ')).not.toContain('FolderBrowserDialog');
  });

  it('prefers the modern Windows folder picker on WSL', () => {
    const commands = buildDirectoryPickerCommands('linux', '/home/ryder', { isWsl: true });
    expect(commands.map((entry) => entry.command)).toEqual(['powershell.exe', 'zenity', 'kdialog']);
    expect(commands[0].env.PICHAMBER_FOLDER_PICKER_START).toBe('/home/ryder');
  });

  it('uses the modern Windows folder picker on Windows', () => {
    const commands = buildDirectoryPickerCommands('win32', 'C:\\Users\\ryder');
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe('powershell.exe');
    expect(commands[0].args).toContain('-EncodedCommand');
    expect(commands[0].env.PICHAMBER_FOLDER_PICKER_START).toBe('C:\\Users\\ryder');
  });
});

describe('runDirectoryPickerCommand', () => {
  it('returns the picked path on success', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const pending = runDirectoryPickerCommand(spawn, 'zenity', ['--file-selection', '--directory']);
    child.stdout.emit('data', '/home/ryder/src\n');
    child.emit('close', 0);
    await expect(pending).resolves.toEqual({ path: '/home/ryder/src' });
  });

  it('treats a missing binary as skippable', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const pending = runDirectoryPickerCommand(spawn, 'zenity', []);
    child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await expect(pending).resolves.toEqual({ missing: true });
  });

  it('treats a non-zero exit as cancelled', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const pending = runDirectoryPickerCommand(spawn, 'zenity', []);
    child.emit('close', 1);
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});

describe('pickHostDirectory', () => {
  it('skips missing pickers and returns the first successful path', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ missing: true })
      .mockResolvedValueOnce({ path: '/picked' });

    await expect(pickHostDirectory({
      platform: 'linux',
      spawn: vi.fn(),
      defaultPath: '/home/ryder',
      isWsl: false,
      runCommand,
    })).resolves.toEqual({ status: 'ok', path: '/picked' });

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('converts a Windows path to a WSL path after picking', async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce({ path: 'C:\\Users\\ryder\\src' })
      .mockResolvedValueOnce({ path: '/mnt/c/Users/ryder/src' });

    await expect(pickHostDirectory({
      platform: 'linux',
      spawn: vi.fn(),
      isWsl: true,
      runCommand,
    })).resolves.toEqual({ status: 'ok', path: '/mnt/c/Users/ryder/src' });

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'wslpath',
      ['-u', 'C:\\Users\\ryder\\src'],
    );
  });

  it('returns cancelled without trying later pickers', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({ cancelled: true });
    await expect(pickHostDirectory({
      platform: 'linux',
      spawn: vi.fn(),
      isWsl: false,
      runCommand,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable when no picker binary exists', async () => {
    const runCommand = vi.fn().mockResolvedValue({ missing: true });
    await expect(pickHostDirectory({
      platform: 'linux',
      spawn: vi.fn(),
      isWsl: false,
      runCommand,
    })).resolves.toEqual({ status: 'unavailable' });
  });
});
