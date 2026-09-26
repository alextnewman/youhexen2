import { extractZipEntries } from './lib/zip.js';
import { hasRequiredBaseAssets, mapImportedPath } from './lib/paths.js';
import {
  createSaveBundle, getPakCompatibilityWarnings, isSavePath, planSaveImport, sha256, validateSaveBundle,
} from './lib/save-bundle.js';
import { PhoneControls, PHONE_CONTROL_KEYCODES } from './lib/phone-controls.js';
import { GyroAim } from './lib/gyro-aim.js';
import { probeWebGPU } from './lib/webgpu-probe.js';

const BASE_DIR = '/persistent';
const ENGINE_ARGUMENTS = ['-basedir', BASE_DIR];
const STORAGE_ROOT = 'hexenwail';

function getEngineArguments() {
  const args = [...ENGINE_ARGUMENTS];
  args.push('+scr_perf', state.preferences.perfCapture ? '1' : '0');
  return args;
}
const PREFERENCES_KEY = 'hexenwail-pwa-preferences-v1';
const SAVE_SYNC_INTERVAL_MS = 10000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RUNTIME_LOG_ENTRIES = 200;
const PERF_REPORT_KEY = 'hexenwail-latest-perf-report';
/* Phone mode is about the short side of the panel, not the long one: every
 * phone has a short side well under 500 CSS px in either orientation, while
 * the smallest iPad short side is ~740. The old 820px rule matched iPad
 * landscape and permanently trapped iPads in phone mode.
 *
 * Size only, deliberately: a phone-sized panel is a phone-sized panel whether
 * or not a mouse, trackpad or pen happens to be attached, and an iPad in a
 * narrow Split View column is one too. Pointer capability is a separate
 * question, answered by isLikelyTouchOnlyEnvironment(). */
const PHONE_VIEWPORT_QUERY = '(max-width: 500px), (max-height: 500px)';

const state = {
  storage: null,
  runtimeReady: false,
  runtimeLoaded: false,
  rendererReady: false,
  storageReady: false,
  engineStarted: false,
  syncing: false,
  syncPromise: null,
  applyingSaveImport: false,
  storedPaths: new Set(),
  runtimeSnapshot: new Map(),
  lastStatus: 'Preparing launcher…',
  runtimeExited: false,
  quitInProgress: false,
  serviceWorkerReloading: false,
  serviceWorkerRegistration: null,
  runtimeLogEntries: [],
  phoneControls: null,
  gyroAim: null,
  preferences: {
    touchControls: 'auto',
    handedness: 'right',
    lookSensitivity: 1,
    gyroAim: false,
    gyroSensitivity: 1,
    gyroInvertY: false,
    perfCapture: false,
    phoneHintSeen: false,
    /* Which WebAssembly bundle to load at launcher startup:
     *   'software' -> ./hexenwail.js       (software + WebGPU presentation)
     *   'nitro'    -> ./hexenwail-nitro.js (shipping WebGlideNitro default)
     * Both bundles share the launcher's WebGPU device handoff but otherwise
     * render independently.
     * The engine script is loaded once during init(), so a change here
     * takes effect on the next launcher load; savePreferences() is what
     * makes the choice survive that reload. */
    renderer: 'nitro',
  },
  touchOnlyEnvironment: false,
  gamepadConnected: false,
  phoneMode: false,
  immersive: false,
  canvasResizePending: false,
  perfReport: '',
};

const ui = {};

function getBoot() {
  if (!globalThis.HexenwailBoot) {
    globalThis.HexenwailBoot = {};
  }
  return globalThis.HexenwailBoot;
}

function getModule() {
  if (!globalThis.Module) {
    globalThis.Module = {
      preRun: [],
      postRun: [],
      arguments: getEngineArguments(),
      noInitialRun: true,
      locateFile: (path) => new URL(path, document.baseURI).toString(),
    };
  }
  return globalThis.Module;
}

function getFS() {
  return globalThis.FS || getModule().FS;
}

function setStatus(message, kind = 'info') {
  state.lastStatus = message;
  appendRuntimeLog('[status]', message);
  if (ui.statusText) {
    ui.statusText.textContent = message;
  }
  if (ui.statusPanel) {
    ui.statusPanel.dataset.kind = kind;
  }
}

function setEngineState(engineState) {
  document.body.dataset.engineState = engineState;
  if (engineState !== 'running') {
    releasePhoneInputs();
    setImmersive(false);
  }
}

function renderRuntimeLog() {
  if (!ui.runtimeLog) return;
  const followTail = ui.runtimeLog.scrollHeight - ui.runtimeLog.scrollTop - ui.runtimeLog.clientHeight <= 8;
  ui.runtimeLog.textContent = state.runtimeLogEntries.join('\n');
  if (followTail) {
    ui.runtimeLog.scrollTop = ui.runtimeLog.scrollHeight;
  }
}

function appendRuntimeLog(prefix, message) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const lines = String(message ?? '').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    state.runtimeLogEntries.push(`${timestamp} ${prefix} ${line}`);
  }
  if (state.runtimeLogEntries.length > MAX_RUNTIME_LOG_ENTRIES) {
    state.runtimeLogEntries.splice(0, state.runtimeLogEntries.length - MAX_RUNTIME_LOG_ENTRIES);
  }
  renderRuntimeLog();
}

function renderPerfReport() {
  if (!ui.perfOutput) return;
  const environment = [
    'capture_environment',
    `captured_at=${new Date().toISOString()}`,
    `user_agent=${navigator.userAgent}`,
    `device_pixel_ratio=${globalThis.devicePixelRatio || 1}`,
    `canvas_pixels=${ui.canvas?.width || 0}x${ui.canvas?.height || 0}`,
    '',
  ].join('\n');
  ui.perfOutput.value = `${environment}${state.perfReport}\n\nruntime_log\n${state.runtimeLogEntries.join('\n')}`;
}

async function copyPerfReport() {
  renderPerfReport();
  if (!ui.perfOutput?.value) return;
  try {
    await navigator.clipboard.writeText(ui.perfOutput.value);
    if (ui.perfMessage) ui.perfMessage.textContent = 'Performance report copied.';
  } catch {
    ui.perfOutput.focus();
    ui.perfOutput.select();
    if (ui.perfMessage) ui.perfMessage.textContent = 'Select all and copy the highlighted report.';
  }
}

function handlePerfReport(event) {
  state.perfReport = String(event.detail ?? '');
  try {
    sessionStorage.setItem(PERF_REPORT_KEY, state.perfReport);
  } catch {
    // The report remains available for this launcher session.
  }
  renderPerfReport();
}

function logToConsole(prefix, message, error = false) {
  const text = typeof message === 'string' ? message : String(message ?? '');
  appendRuntimeLog(prefix, text);
  if (error) {
    console.error(prefix, text);
  } else {
    console.log(prefix, text);
  }
}

function updateLaunchState() {
  const ready = hasRequiredBaseAssets([...state.storedPaths]);
  if (ui.launchButton) {
    ui.launchButton.disabled = !state.rendererReady || !ready || (state.engineStarted && !state.runtimeExited);
    ui.launchButton.textContent = !state.rendererReady
      ? 'WebGPU unavailable'
      : state.runtimeExited
      ? 'Restart game'
      : state.engineStarted
        ? 'Running'
        : ready ? 'Start game' : 'Import pak0.pak + pak1.pak first';
  }
  if (ui.exitButton) {
    ui.exitButton.disabled = !state.engineStarted || state.runtimeExited;
  }
  if (ui.fullscreenButton) {
    const playing = state.engineStarted && !state.runtimeExited;
    ui.fullscreenButton.disabled = !playing;
    ui.fullscreenButton.textContent = state.immersive ? 'Show launcher' : 'Fullscreen play';
  }
  if (ui.requirementsText) {
    ui.requirementsText.textContent = !state.rendererReady
      ? 'WebGPU initialization failed. See the runtime log.'
      : ready
      ? 'Required base game assets detected.'
      : 'Required: data1/pak0.pak and data1/pak1.pak from a legal Hexen II installation.';
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'unknown';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function setImportMessage(message, kind = 'info') {
  if (ui.importMessage) {
    ui.importMessage.textContent = message;
    ui.importMessage.dataset.kind = kind;
  }
}

function setSaveMessage(message, kind = 'info') {
  if (ui.saveMessage) {
    ui.saveMessage.textContent = message;
    ui.saveMessage.dataset.kind = kind;
  }
}

async function updateStorageIndicator() {
  if (!navigator.storage || !ui.storageText) {
    return;
  }

  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage.estimate?.(),
      navigator.storage.persisted?.(),
    ]);
    const usage = estimate?.usage ?? 0;
    const quota = estimate?.quota ?? 0;
    ui.storageText.textContent = `Browser storage: ${formatBytes(usage)} used / ${formatBytes(quota)} quota · persistence ${persisted ? 'granted' : 'best-effort'}`;
  } catch (error) {
    ui.storageText.textContent = 'Browser storage estimate unavailable.';
    console.warn(error);
  }
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch (error) {
    console.warn('Persistent storage request failed', error);
    return false;
  }
}

async function ensureRuntimeDirectory(path) {
  const FS = getFS();
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch (error) {
      if (!String(error).includes('File exists')) {
        try {
          FS.lookupPath(current);
        } catch {
          throw error;
        }
      }
    }
  }
}

function relativeFromBase(absolutePath) {
  if (absolutePath === BASE_DIR) {
    return '';
  }
  return absolutePath.startsWith(`${BASE_DIR}/`) ? absolutePath.slice(BASE_DIR.length + 1) : absolutePath;
}

function toMtimeMs(value) {
  if (typeof value === 'number') {
    return value;
  }
  if (value?.getTime) {
    return value.getTime();
  }
  return Date.now();
}

async function writeRuntimeFile(relativePath, bytes) {
  const FS = getFS();
  const absolutePath = `${BASE_DIR}/${relativePath}`;
  const directory = absolutePath.split('/').slice(0, -1).join('/');
  await ensureRuntimeDirectory(directory);
  FS.writeFile(absolutePath, bytes);
  const stat = FS.stat(absolutePath);
  state.runtimeSnapshot.set(relativePath, { size: stat.size, mtimeMs: toMtimeMs(stat.mtime) });
}

function walkRuntimeFiles(path = BASE_DIR, files = []) {
  const FS = getFS();
  for (const name of FS.readdir(path)) {
    if (name === '.' || name === '..') {
      continue;
    }
    const child = `${path}/${name}`;
    const stat = FS.stat(child);
    if (FS.isDir(stat.mode)) {
      walkRuntimeFiles(child, files);
    } else {
      files.push({ absolutePath: child, stat });
    }
  }
  return files;
}

function normalizeStoredMetadata(stat) {
  return {
    size: stat.size,
    mtimeMs: toMtimeMs(stat.mtime),
  };
}

function removeRuntimeTree(path) {
  const FS = getFS();
  for (const name of FS.readdir(path)) {
    if (name === '.' || name === '..') {
      continue;
    }
    const child = `${path}/${name}`;
    const stat = FS.stat(child);
    if (FS.isDir(stat.mode)) {
      removeRuntimeTree(child);
      FS.rmdir(child);
    } else {
      FS.unlink(child);
    }
  }
}

async function syncRuntimeToStorage() {
  if (!state.runtimeReady || !state.storageReady || state.syncing || state.applyingSaveImport) {
    return state.syncPromise;
  }

  state.syncPromise = (async () => {
    state.syncing = true;
    try {
    const FS = getFS();
    const present = new Set();
    const runtimeFiles = walkRuntimeFiles();

    for (const { absolutePath, stat } of runtimeFiles) {
      const relativePath = relativeFromBase(absolutePath);
      present.add(relativePath);
      const meta = normalizeStoredMetadata(stat);
      const previous = state.runtimeSnapshot.get(relativePath);
      if (!previous || previous.size !== meta.size || previous.mtimeMs !== meta.mtimeMs) {
        const bytes = FS.readFile(absolutePath);
        await state.storage.writeFile(relativePath, bytes, meta);
        state.runtimeSnapshot.set(relativePath, meta);
        state.storedPaths.add(relativePath);
      }
    }

    for (const relativePath of [...state.runtimeSnapshot.keys()]) {
      if (!present.has(relativePath)) {
        await state.storage.deleteFile(relativePath);
        state.runtimeSnapshot.delete(relativePath);
        state.storedPaths.delete(relativePath);
      }
    }
    } finally {
      state.syncing = false;
      updateLaunchState();
      updateStorageIndicator();
    }
  })();
  return state.syncPromise;
}

async function loadStoredFilesIntoRuntime() {
  if (!state.runtimeReady || !state.storageReady) {
    return;
  }

  const files = await state.storage.listFiles();
  state.storedPaths = new Set(files.map((file) => file.path));
  setStatus(files.length ? 'Restoring imported game data…' : 'Waiting for Hexen II assets…');
  await ensureRuntimeDirectory(BASE_DIR);

  let restoredBytes = 0;
  let index = 0;
  for (const file of files) {
    const bytes = await state.storage.readFile(file.path);
    await writeRuntimeFile(file.path, bytes);
    restoredBytes += bytes.byteLength;
    index += 1;
    if (ui.progressText) {
      ui.progressText.textContent = `Restored ${index}/${files.length} files (${formatBytes(restoredBytes)})`;
    }
  }

  updateLaunchState();
  if (!files.length && ui.progressText) {
    ui.progressText.textContent = 'No imported assets yet.';
  }
}

function isZipFile(file) {
  return file.name.toLowerCase().endsWith('.zip');
}

function collectLooseFiles(fileList) {
  return Array.from(fileList, (file) => ({
    sourcePath: file.webkitRelativePath || file.name,
    file,
  }));
}

async function importFileBatch(entries) {
  let processedBytes = 0;
  const accepted = [];
  const rejected = [];

  for (const entry of entries) {
    const mappedPath = mapImportedPath(entry.sourcePath);
    if (!mappedPath) {
      rejected.push(entry.sourcePath);
      continue;
    }
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    processedBytes += bytes.byteLength;
    accepted.push({ path: mappedPath, bytes });
    if (ui.progressText) {
      ui.progressText.textContent = `Imported ${accepted.length} files (${formatBytes(processedBytes)})`;
    }
  }

  for (const item of accepted) {
    await state.storage.writeFile(item.path, item.bytes, { size: item.bytes.byteLength, mtimeMs: Date.now() });
    state.storedPaths.add(item.path);
    if (state.runtimeReady) {
      await writeRuntimeFile(item.path, item.bytes);
    }
  }

  return { accepted, rejected };
}

async function importZipFile(file) {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`ZIP file is too large for browser storage (${formatBytes(file.size)}).`);
  }

  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  const extracted = await extractZipEntries(archiveBytes, {
    onProgress: ({ processedBytes, totalBytes, entry }) => {
      if (ui.progressText) {
        ui.progressText.textContent = `Extracting ${entry.rawName} (${formatBytes(processedBytes)} / ${formatBytes(totalBytes)})`;
      }
    },
  });

  const accepted = [];
  const rejected = [];
  for (const entry of extracted) {
    const mappedPath = mapImportedPath(entry.name);
    if (!mappedPath) {
      rejected.push(entry.rawName);
      continue;
    }
    accepted.push({ path: mappedPath, bytes: entry.data });
  }

  let processedBytes = 0;
  for (const item of accepted) {
    processedBytes += item.bytes.byteLength;
    await state.storage.writeFile(item.path, item.bytes, { size: item.bytes.byteLength, mtimeMs: Date.now() });
    state.storedPaths.add(item.path);
    if (state.runtimeReady) {
      await writeRuntimeFile(item.path, item.bytes);
    }
    if (ui.progressText) {
      ui.progressText.textContent = `Stored ${accepted.length} extracted files (${formatBytes(processedBytes)})`;
    }
  }

  return { accepted, rejected };
}

async function handleImportedFiles(fileList) {
  if (!fileList?.length) {
    return;
  }

  setImportMessage('Importing assets…');
  const zipFiles = [];
  const looseFiles = [];
  for (const entry of collectLooseFiles(fileList)) {
    if (isZipFile(entry.file)) {
      zipFiles.push(entry.file);
    } else {
      looseFiles.push(entry);
    }
  }

  const accepted = [];
  const rejected = [];
  for (const file of zipFiles) {
    const result = await importZipFile(file);
    accepted.push(...result.accepted.map((item) => item.path));
    rejected.push(...result.rejected);
  }
  if (looseFiles.length) {
    const result = await importFileBatch(looseFiles);
    accepted.push(...result.accepted.map((item) => item.path));
    rejected.push(...result.rejected);
  }

  await updateStorageIndicator();
  updateLaunchState();

  if (accepted.length) {
    setImportMessage(`Imported ${accepted.length} file(s). Existing files were replaced when names matched. Start the game when ready.`, 'success');
  } else {
    setImportMessage('No recognized Hexen II assets were imported.', 'error');
  }
  if (rejected.length && ui.rejectedList) {
    ui.rejectedList.textContent = `Ignored ${rejected.length} item(s): ${rejected.slice(0, 8).join(', ')}${rejected.length > 8 ? '…' : ''}`;
  } else if (ui.rejectedList) {
    ui.rejectedList.textContent = '';
  }
}

async function getInstalledPaks(gameDirectories) {
  const paks = [];
  const normalizedDirs = gameDirectories ? gameDirectories.map(d => d.toLowerCase()) : null;
  for (const entry of await state.storage.listFiles()) {
    if (!/^(?:data1|portals|hw)\/.*\.pak$/i.test(entry.path)) continue;
    if (normalizedDirs && !normalizedDirs.includes(entry.path.split('/')[0].toLowerCase())) continue;
    const bytes = await state.storage.readFile(entry.path);
    paks.push({ path: entry.path, size: bytes.byteLength, sha256: await sha256(bytes) });
  }
  return paks;
}

async function exportSaves() {
  try {
    setSaveMessage('Syncing recent saves to local storage…');
    await syncRuntimeToStorage();
    const stored = await state.storage.listFiles();
    const saveEntries = [];
    for (const entry of stored) {
      if (!isSavePath(entry.path)) continue;
      saveEntries.push({ path: entry.path, bytes: await state.storage.readFile(entry.path) });
    }
    if (!saveEntries.length) {
      setSaveMessage('No save files were found. Save a game first, then return to the launcher and export.', 'error');
      return;
    }
    setSaveMessage(`Preparing ${saveEntries.length} save file(s)…`);
    const { bytes } = await createSaveBundle(saveEntries, {
      build: globalThis.HEXENWAIL_BUILD,
      requiredPaks: await getInstalledPaks([...new Set(saveEntries.map((entry) => entry.path.split('/')[0]))]),
    });
    const date = new Date().toISOString().slice(0, 10);
    const filename = `hexenwail-saves-${date}.hexenwail-save.zip`;
    const file = new File([bytes], filename, { type: 'application/zip' });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'YouHexen2 save bundle' });
        setSaveMessage(`Exported ${saveEntries.length} save file(s), ${formatBytes(bytes.byteLength)}.`, 'success');
        return;
      } catch (error) {
        if (error.name === 'AbortError') {
          setSaveMessage('Save export was cancelled.');
          return;
        }
      }
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    setSaveMessage(`Downloaded ${saveEntries.length} save file(s), ${formatBytes(bytes.byteLength)}. Use Files or iCloud Drive to move it.`, 'success');
  } catch (error) {
    setSaveMessage(`Save export failed: ${error.message}`, 'error');
  }
}

async function deleteRuntimeFile(relativePath) {
  if (!state.runtimeReady) return;
  try {
    getFS().unlink(`${BASE_DIR}/${relativePath}`);
  } catch (error) {
    if (!String(error).includes('No such file')) throw error;
  }
  state.runtimeSnapshot.delete(relativePath);
}

async function applySaveImport(bundle, mode) {
  await syncRuntimeToStorage();
  state.applyingSaveImport = true;
  try {
    const existing = (await state.storage.listFiles()).map((entry) => entry.path);
    const { writes, deletes } = planSaveImport(existing, bundle.files, mode);
    const affected = [...new Set([...writes, ...deletes])];
    const before = new Map();
    for (const path of affected) {
      if (existing.includes(path)) before.set(path, await state.storage.readFile(path));
    }
    try {
      for (const file of bundle.files) {
        if (!writes.includes(file.path)) continue;
        await state.storage.writeFile(file.path, file.bytes, { size: file.bytes.byteLength, mtimeMs: Date.now() });
        state.storedPaths.add(file.path);
      }
      for (const path of deletes) {
        await state.storage.deleteFile(path);
        state.storedPaths.delete(path);
      }
    } catch (error) {
      for (const path of affected) {
        if (before.has(path)) {
          const bytes = before.get(path);
          await state.storage.writeFile(path, bytes, { size: bytes.byteLength, mtimeMs: Date.now() }).catch(() => {});
          state.storedPaths.add(path);
        } else {
          await state.storage.deleteFile(path).catch(() => {});
          state.storedPaths.delete(path);
        }
      }
      throw new Error(`Save import could not be committed; prior saves were restored (${error.message})`);
    }
    try {
      for (const file of bundle.files) {
        if (!writes.includes(file.path)) continue;
        await writeRuntimeFile(file.path, file.bytes);
      }
      for (const path of deletes) await deleteRuntimeFile(path);
    } catch (error) {
      console.warn('Imported saves will be loaded after reload', error);
    }
    return { writes, deletes };
  } finally {
    state.applyingSaveImport = false;
  }
}

async function importSaveBundle(file) {
  try {
    if (file.size > 256 * 1024 * 1024) throw new Error('Save bundle is too large.');
    setSaveMessage('Checking save bundle…');
    const bundle = await validateSaveBundle(new Uint8Array(await file.arrayBuffer()));
    const warnings = getPakCompatibilityWarnings(bundle.manifest.requiredPaks, await getInstalledPaks(bundle.manifest.gameDirectories));
    const size = bundle.files.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    const mode = ui.saveImportMode?.value === 'replace' ? 'replace' : 'merge';
    const summary = `Import ${bundle.files.length} save file(s) (${formatBytes(size)}) from ${new Date(bundle.manifest.createdAt).toLocaleString()} for ${bundle.manifest.gameDirectories.join(', ')}?\n\nMode: ${mode === 'replace' ? 'Replace saves (all existing save slots are removed)' : 'Merge (only matching save paths are replaced)'}${warnings.length ? `\n\nCompatibility warnings:\n${warnings.join('\n')}` : ''}`;
    setSaveMessage(`Ready to import ${bundle.files.length} save file(s) from ${new Date(bundle.manifest.createdAt).toLocaleString()}.${warnings.length ? ` ${warnings.join(' ')}` : ''}`);
    if (!confirm(summary)) return;
    const result = await applySaveImport(bundle, mode);
    setSaveMessage(`Imported ${result.writes.length} save file(s)${result.deletes.length ? ` and removed ${result.deletes.length} existing save file(s)` : ''}.${state.engineStarted ? ' Restart/reload before loading saves to avoid an active-game race.' : ''}`, 'success');
  } catch (error) {
    setSaveMessage(`Save import failed: ${error.message}`, 'error');
  }
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}');
    if (['auto', 'on', 'off'].includes(saved.touchControls)) state.preferences.touchControls = saved.touchControls;
    if (['right', 'left'].includes(saved.handedness)) state.preferences.handedness = saved.handedness;
    const sensitivity = Number(saved.lookSensitivity);
    if (Number.isFinite(sensitivity) && sensitivity >= 0.5 && sensitivity <= 2) state.preferences.lookSensitivity = sensitivity;
    state.preferences.gyroAim = Boolean(saved.gyroAim);
    const gyroSensitivity = Number(saved.gyroSensitivity);
    if (Number.isFinite(gyroSensitivity) && gyroSensitivity >= 0.25 && gyroSensitivity <= 2) state.preferences.gyroSensitivity = gyroSensitivity;
    state.preferences.gyroInvertY = Boolean(saved.gyroInvertY);
    state.preferences.perfCapture = typeof saved.perfCapture === 'boolean'
      ? saved.perfCapture
      : Number(saved.perfOverlay) > 0;
    state.preferences.phoneHintSeen = Boolean(saved.phoneHintSeen);
    if (['software', 'nitro'].includes(saved.renderer)) state.preferences.renderer = saved.renderer;
  } catch (error) {
    console.warn('Could not load launcher preferences', error);
  }
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(state.preferences));
  } catch (error) {
    console.warn('Could not save launcher preferences', error);
  }
}

function isTouchControlsVisible() {
  if (state.preferences.touchControls === 'on') {
    return true;
  }
  if (state.preferences.touchControls === 'off') {
    return false;
  }
  return state.touchOnlyEnvironment;
}

function applyPreferences() {
  document.body.dataset.touchControls = state.preferences.touchControls;
  document.body.dataset.handedness = state.preferences.handedness;
  document.body.dataset.touchOnly = state.touchOnlyEnvironment ? 'true' : 'false';
  /* A connected controller replaces the launcher's on-screen chrome: the
   * engine binds Start to its own menu, so the ☰ button is hidden rather than
   * painted over the game. */
  document.body.dataset.gamepad = state.gamepadConnected ? 'true' : 'false';
  document.body.dataset.phoneMode = state.phoneMode ? 'true' : 'false';
  /* A panel this small cannot usefully share space with the launcher chrome,
   * whatever is plugged into it, so phone mode pins the immersive layout. */
  document.body.dataset.immersive = (state.immersive || state.phoneMode) ? 'true' : 'false';
  if (ui.touchControlsSetting) ui.touchControlsSetting.value = state.preferences.touchControls;
  if (ui.handednessSetting) ui.handednessSetting.value = state.preferences.handedness;
  if (ui.lookSensitivitySetting) ui.lookSensitivitySetting.value = String(state.preferences.lookSensitivity);
  if (ui.gyroAimSetting) ui.gyroAimSetting.value = state.preferences.gyroAim ? 'on' : 'off';
  if (ui.gyroSensitivitySetting) ui.gyroSensitivitySetting.value = String(state.preferences.gyroSensitivity);
  if (ui.gyroInvertYSetting) ui.gyroInvertYSetting.checked = state.preferences.gyroInvertY;
  if (ui.perfSetting) ui.perfSetting.value = state.preferences.perfCapture ? '1' : '0';
  if (ui.rendererSetting) ui.rendererSetting.value = state.preferences.renderer;
  if (ui.phoneHint && state.preferences.phoneHintSeen) {
    ui.phoneHint.textContent = 'Touch controls are available during play. Landscape remains recommended.';
  }
  if (state.runtimeReady && !state.runtimeExited) {
    callEngine('Web_TouchControlsVisible', null, [['number', isTouchControlsVisible() ? 1 : 0]]);
  }
  state.phoneControls?.setLookSensitivity(state.preferences.lookSensitivity);
  state.gyroAim?.setSensitivity(state.preferences.gyroSensitivity);
  state.gyroAim?.setInvertY(state.preferences.gyroInvertY);
  state.gyroAim?.setEnabled(state.preferences.gyroAim);
}

function callEngine(name, returnType, args = []) {
  const Module = getModule();
  if (typeof Module.ccall !== 'function') {
    return null;
  }
  try {
    return Module.ccall(name, returnType, args.map(([type]) => type), args.map(([, value]) => value));
  } catch (error) {
    console.warn(`Engine call failed: ${name}`, error);
    return null;
  }
}

/* Ask the running engine to write config.cfg into the runtime filesystem
 * now, without quitting. Called on every lifecycle path that can bypass the
 * in-game Quit menu (return-to-launcher, tab hide/close, PWA suspend) so key
 * mappings and settings are not lost when Host_Shutdown never runs. Safe to
 * call when the engine is not running: callEngine no-ops and the export must
 * exist in EXPORTED_FUNCTIONS or the call fails silently at runtime. */
function flushEngineConfig() {
  callEngine('Web_FlushConfig', null, []);
}

function engineKey(key, down) {
  if (state.runtimeReady && !state.runtimeExited) {
    const ok = callEngine('Web_TouchKey', 'number', [['number', key], ['number', down ? 1 : 0]]);
    if (ok) return;
  }
  const type = down ? 'keydown' : 'keyup';
  const event = new KeyboardEvent(type, { key: String.fromCharCode(key), bubbles: true, cancelable: true });
  ui.canvas?.dispatchEvent(event);
}

function engineLook(dx, dy) {
  if (!state.runtimeReady || state.runtimeExited) return;
  callEngine('Web_TouchLook', null, [['number', dx], ['number', dy]]);
}

function engineGyroLook(dx, dy) {
  if (!state.runtimeReady || state.runtimeExited) return;
  callEngine('Web_GyroLook', null, [['number', dx], ['number', dy]]);
}

function releasePhoneInputs() {
  state.phoneControls?.releaseAll();
}

function gyroGameplayActive() {
  return state.engineStarted
    && !state.runtimeExited
    && document.visibilityState !== 'hidden'
    && document.body.dataset.touchMenu !== 'true';
}

function setGyroMessage(message) {
  if (ui.gyroMessage) ui.gyroMessage.textContent = message;
}

function requestGyroPermission() {
  if (!state.preferences.gyroAim) return;
  state.gyroAim?.requestPermission().then((permission) => {
    if (permission === 'denied') {
      setGyroMessage('Device motion permission was denied. A controller gyro can still work if the browser exposes it.');
    } else if (permission === 'unavailable') {
      setGyroMessage('This browser does not expose device motion. A controller gyro can still work if exposed through the Gamepad API.');
    } else if (permission === 'granted') {
      setGyroMessage('Gyro aim is ready for touch play and browser-exposed controller motion.');
    }
  });
}

function suppressBrowserZoom(event) {
  if (!event || !('preventDefault' in event) || !event.cancelable) {
    return;
  }
  const playing = state.engineStarted && !state.runtimeExited && (state.immersive || state.phoneMode);
  if (!playing) {
    return;
  }
  const target = event.target;
  const interactiveOverlay = target instanceof Element
    ? target.closest?.('#phone-menu-button, .phone-overlay button') != null
    : false;
  const insideGameSurface = target instanceof Element
    ? target.closest?.('.viewport, .phone-controls, #canvas, .canvas-hint') != null
    : false;
  /* The floating menu button and the overlay controls live inside the game
   * viewport but are launch UI, not game input. Let their taps pass through so
   * iOS Safari can synthesize the click while the rest of the game surface stays
   * zoom-proof. */
  if (event.type.startsWith('gesture') || (insideGameSurface && !interactiveOverlay)) {
    event.preventDefault();
  }
}

function hasConnectedGamepad() {
  try {
    return Boolean(navigator.getGamepads?.().some(Boolean));
  } catch {
    return false;
  }
}

/* Touch controls follow pointer capability only. Screen size says nothing
 * useful here: a bare iPad is exactly as touch-only as a phone, and an iPad
 * on a Magic Keyboard is not touch-only at all. */
function isLikelyTouchOnlyEnvironment() {
  const hasCoarsePointer = matchMedia('(any-pointer: coarse)').matches || matchMedia('(pointer: coarse)').matches;
  const hasFinePointer = matchMedia('(any-pointer: fine)').matches || matchMedia('(any-hover: hover)').matches;
  return hasCoarsePointer && !hasFinePointer && !hasConnectedGamepad();
}

/* Phone mode only means "small panel": it forces the immersive layout and
 * keeps the launcher chrome out of a viewport too small to share. It is a
 * pure function of size, so it is self-healing — rotate or resize back above
 * the breakpoint and the chrome returns on its own. */
function isPhoneModeEnvironment() {
  return matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

function updateTouchOnlyEnvironment(forceOff = false) {
  const wasPhoneMode = state.phoneMode;
  state.phoneMode = isPhoneModeEnvironment();
  /* Sticky until an explicit disconnect: Safari only lists a pad through
   * navigator.getGamepads() once it has sent input, so the connect event is
   * the authoritative signal and the poll is the fallback for a page that
   * loads with one already attached. */
  state.gamepadConnected = state.gamepadConnected || hasConnectedGamepad();
  state.touchOnlyEnvironment = !forceOff && isLikelyTouchOnlyEnvironment();
  if (!state.touchOnlyEnvironment) {
    releasePhoneInputs();
  }
  applyPreferences();
  if (wasPhoneMode !== state.phoneMode) {
    updateLaunchState();
    scheduleCanvasResize();
  }
}

function togglePhoneMenuButton() {
  releasePhoneInputs();
  engineKey(PHONE_CONTROL_KEYCODES.menu, true);
  engineKey(PHONE_CONTROL_KEYCODES.menu, false);
}

function closePhoneOverlay() {
  if (ui.phoneOverlay) ui.phoneOverlay.setAttribute('aria-hidden', 'true');
  tryCaptureInput();
}

async function returnToLauncher() {
  releasePhoneInputs();
  await exitNativeFullscreen();
  setStatus('Syncing saves before returning to the launcher…');
  flushEngineConfig();
  await syncRuntimeToStorage();
  location.reload();
}

function resizeCanvasToViewport() {
  if (!ui.canvas || !ui.viewport) return;
  const rect = ui.viewport.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(rect.width || globalThis.visualViewport?.width || innerWidth || 1));
  const cssHeight = Math.max(1, Math.floor(rect.height || globalThis.visualViewport?.height || innerHeight || 1));
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
  if (ui.canvas.width !== pixelWidth) ui.canvas.width = pixelWidth;
  if (ui.canvas.height !== pixelHeight) ui.canvas.height = pixelHeight;
  ui.canvas.style.width = `${cssWidth}px`;
  ui.canvas.style.height = `${cssHeight}px`;
  if (state.runtimeReady && !state.runtimeExited) {
    callEngine('Web_ResizeCanvas', null, [['number', cssWidth], ['number', cssHeight]]);
  }
}

/* Coalesced: fullscreen, orientation and visualViewport changes arrive in
 * bursts, and several callers legitimately ask for a resize in the same turn
 * (setImmersive plus its caller, for one). Each pass measures layout and calls
 * into the engine, so one scheduled pair of frames per turn is enough — the
 * trailing frame catches the post-transition layout. */
function scheduleCanvasResize() {
  if (state.canvasResizePending) return;
  state.canvasResizePending = true;
  requestAnimationFrame(() => {
    state.canvasResizePending = false;
    resizeCanvasToViewport();
    requestAnimationFrame(resizeCanvasToViewport);
  });
}

async function handleEngineQuit(kind = 'quit', message = '') {
  if (state.quitInProgress) return;
  state.quitInProgress = true;
  releasePhoneInputs();
  const intentional = kind === 'quit';
  try {
    setStatus(intentional ? 'YouHexen2 quit. Syncing saves…' : `Engine stopped unexpectedly. Syncing saves…`, intentional ? 'info' : 'error');
    await syncRuntimeToStorage();
  } catch (error) {
    console.warn('Quit-time save sync failed', error);
  } finally {
    state.engineStarted = false;
    state.runtimeExited = true;
    setEngineState(intentional ? 'stopped' : 'fatal');
    exitNativeFullscreen().catch((error) => console.warn('Leaving fullscreen failed', error));
    closePhoneOverlay();
    setStatus(intentional
      ? 'YouHexen2 stopped. Use Restart game to start a fresh WASM runtime.'
      : `Engine fatal error: ${message || 'unknown error'}. Restart game reloads a clean runtime.`, intentional ? 'info' : 'error');
    updateLaunchState();
    state.quitInProgress = false;
  }
}

async function startEngineFromUserAction() {
  if (state.engineStarted || !state.rendererReady || !state.runtimeReady || !state.storageReady || !hasRequiredBaseAssets([...state.storedPaths])) {
    return;
  }
  state.engineStarted = true;
  setEngineState('running');
  state.preferences.phoneHintSeen = true;
  savePreferences();
  applyPreferences();
  requestGyroPermission();
  /* Started from a click, so this is a valid user gesture: take fullscreen
   * now, while the activation is still fresh, and let the layout settle
   * before the first frame is drawn. */
  enterFullscreenPlay().catch((error) => appendRuntimeLog('[launcher]', `Fullscreen on launch failed: ${error.message}`));
  scheduleCanvasResize();
  setStatus('Starting YouHexen2…');
  try {
    const Module = getModule();
    if (typeof Module.callMain !== 'function') {
      throw new Error('Engine runtime did not expose callMain.');
    }
    const exitStatus = Module.callMain(getEngineArguments());
    if (state.quitInProgress || state.runtimeExited) return;
    if (typeof exitStatus === 'number' && exitStatus !== 0) {
      throw new Error(`Engine exited during startup with status ${exitStatus}.`);
    }
    scheduleCanvasResize();
    setStatus('YouHexen2 running. Press ☰ to leave fullscreen or return to the launcher.');
  } catch (error) {
    if (state.quitInProgress) return;
    state.engineStarted = false;
    state.runtimeExited = true;
    setEngineState('fatal');
    setStatus(`Engine start failed: ${error.message}`, 'error');
  }
}

async function clearImportedData() {
  if (!confirm('This removes all imported Hexen II assets AND any local save games from this browser. This cannot be undone. Continue?')) {
    return;
  }
  await state.storage.clear();
  state.storedPaths.clear();
  state.runtimeSnapshot.clear();
  if (state.runtimeReady) {
    try {
      const FS = getFS();
      for (const name of FS.readdir(BASE_DIR)) {
        if (name === '.' || name === '..') continue;
        const child = `${BASE_DIR}/${name}`;
        const stat = FS.stat(child);
        if (FS.isDir(stat.mode)) {
          removeRuntimeTree(child);
          FS.rmdir(child);
        } else {
          FS.unlink(child);
        }
      }
    } catch (error) {
      console.warn('Runtime clear failed', error);
    }
  }
  state.engineStarted = false;
  setEngineState(state.runtimeExited ? 'stopped' : 'ready');
  setImportMessage('Imported browser data cleared.', 'success');
  if (ui.rejectedList) ui.rejectedList.textContent = '';
  if (ui.progressText) ui.progressText.textContent = 'No imported assets yet.';
  updateLaunchState();
  updateStorageIndicator();
}

/*
 * Fullscreen play.
 *
 * Two independent layers, deliberately: `state.immersive` is the launcher
 * layout (chrome hidden, game surface owns the window) and always works,
 * including in an installed iOS PWA where the Fullscreen API is missing or
 * refused. Native fullscreen is a best-effort extra on top of it, requested
 * from the same user gesture that starts the game. The game surface, not the
 * bare canvas, is the fullscreen element so the touch controls and the
 * in-game overlay stay on screen.
 */
function getFullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function isFullscreen() {
  return Boolean(getFullscreenElement());
}

function setImmersive(immersive) {
  if (state.immersive === immersive) return;
  state.immersive = immersive;
  applyPreferences();
  updateLaunchState();
  scheduleCanvasResize();
}

async function enterNativeFullscreen() {
  const target = ui.viewport ?? ui.canvas;
  if (!target || isFullscreen()) return false;
  const request = target.requestFullscreen ?? target.webkitRequestFullscreen;
  if (typeof request !== 'function') return false;
  try {
    await request.call(target, { navigationUI: 'hide' });
    return true;
  } catch (error) {
    appendRuntimeLog('[launcher]', `Fullscreen request refused: ${error.message}`);
    return false;
  }
}

async function exitNativeFullscreen() {
  if (!isFullscreen()) return;
  const release = document.exitFullscreen ?? document.webkitExitFullscreen;
  if (typeof release !== 'function') return;
  try {
    await release.call(document);
  } catch (error) {
    appendRuntimeLog('[launcher]', `Leaving fullscreen failed: ${error.message}`);
  }
}

/* Enter immersive play and, where the browser allows it, real fullscreen.
 * Must be called from a user gesture for the fullscreen half to succeed. */
async function enterFullscreenPlay() {
  setImmersive(true);
  const native = await enterNativeFullscreen();
  if (!native && !isFullscreen()) {
    setPointerLockHint('Fullscreen was unavailable, so the launcher hid its chrome instead. An installed PWA already runs edge-to-edge.');
  }
  tryCaptureInput();
}

async function leaveFullscreenPlay() {
  await exitNativeFullscreen();
  setImmersive(false);
}

function toggleFullscreenPlay() {
  const leaving = state.immersive || isFullscreen();
  const action = leaving ? leaveFullscreenPlay() : enterFullscreenPlay();
  action.catch((error) => appendRuntimeLog('[launcher]', `Fullscreen toggle failed: ${error.message}`));
}

function handleFullscreenChange() {
  /* Leaving fullscreen through the browser (Esc on desktop, the system
   * gesture on iPad) must also drop the immersive layout, or the launcher
   * would stay hidden with no way back. Phone mode has no launcher chrome
   * to restore, so it keeps its layout. */
  if (isFullscreen()) {
    if (state.engineStarted && !state.runtimeExited) {
      setImmersive(true);
    }
  } else if (!state.phoneMode) {
    setImmersive(false);
  }
  scheduleCanvasResize();
}

function setPointerLockHint(message) {
  if (ui.pointerLockHint) {
    ui.pointerLockHint.textContent = message;
  }
}

function tryCaptureInput() {
  if (!ui.canvas) return;
  ui.canvas.focus();
  /* Pointer Lock is only meaningful once the engine is drawing, and asking
   * for it from the launcher just logs a browser error. */
  if (!state.engineStarted || state.runtimeExited) return;
  if (typeof ui.canvas.requestPointerLock !== 'function') {
    setPointerLockHint('Pointer Lock is unavailable here (expected on iPadOS Safari). External keyboard/mouse still work without it.');
    return;
  }
  try {
    const result = ui.canvas.requestPointerLock();
    /* Chrome returns a promise; Safari/WebKit does not. */
    result?.catch?.(() => {
      setPointerLockHint('Pointer Lock was refused by the browser. External keyboard/mouse still work without it.');
    });
  } catch {
    setPointerLockHint('Pointer Lock is unavailable here (expected on iPadOS Safari). External keyboard/mouse still work without it.');
  }
}

function createOPFSBackend(rootHandle) {
  async function getDirectoryHandle(relativePath, create = false) {
    let handle = rootHandle;
    for (const segment of relativePath.split('/').filter(Boolean)) {
      handle = await handle.getDirectoryHandle(segment, { create });
    }
    return handle;
  }

  async function getFileHandle(relativePath, create = false) {
    const segments = relativePath.split('/').filter(Boolean);
    const fileName = segments.pop();
    const dir = await getDirectoryHandle(segments.join('/'), create);
    return dir.getFileHandle(fileName, { create });
  }

  async function listRecursive(handle, prefix = '') {
    const items = [];
    for await (const entry of handle.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        items.push(...await listRecursive(entry, path));
      } else {
        const file = await entry.getFile();
        items.push({ path, size: file.size, mtimeMs: file.lastModified });
      }
    }
    return items;
  }

  return {
    async listFiles() {
      return listRecursive(rootHandle);
    },
    async readFile(relativePath) {
      const file = await (await getFileHandle(relativePath, false)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async writeFile(relativePath, bytes) {
      const handle = await getFileHandle(relativePath, true);
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },
    async deleteFile(relativePath) {
      const segments = relativePath.split('/').filter(Boolean);
      const fileName = segments.pop();
      const dir = await getDirectoryHandle(segments.join('/'), false).catch(() => null);
      if (dir) {
        await dir.removeEntry(fileName).catch(() => {});
      }
    },
    async clear() {
      const rootEntries = [];
      for await (const entry of rootHandle.values()) {
        rootEntries.push(entry.name);
      }
      for (const name of rootEntries) {
        await rootHandle.removeEntry(name, { recursive: true });
      }
    },
  };
}

function createIDBBackend() {
  const DB_NAME = 'hexenwail-pwa';
  const STORE_NAME = 'files';

  const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'path' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const run = async (mode, executor) => {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      executor(store, resolve, reject);
      // The executor's own request handler (onsuccess/onerror) always settles
      // this promise before the transaction completes; oncomplete here is
      // solely responsible for closing this per-call connection.
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error);
    });
  };

  return {
    async listFiles() {
      const db = await openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => {
          db.close();
          resolve(request.result.map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs })));
        };
        request.onerror = () => reject(request.error);
      });
    },
    async readFile(relativePath) {
      return run('readonly', (store, resolve, reject) => {
        const request = store.get(relativePath);
        request.onsuccess = () => {
          if (!request.result) {
            reject(new Error(`Missing IndexedDB file: ${relativePath}`));
            return;
          }
          resolve(new Uint8Array(request.result.bytes));
        };
        request.onerror = () => reject(request.error);
      });
    },
    async writeFile(relativePath, bytes, meta = {}) {
      return run('readwrite', (store, resolve, reject) => {
        const request = store.put({ path: relativePath, bytes, size: meta.size ?? bytes.byteLength, mtimeMs: meta.mtimeMs ?? Date.now() });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
    async deleteFile(relativePath) {
      return run('readwrite', (store, resolve, reject) => {
        const request = store.delete(relativePath);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
    async clear() {
      return run('readwrite', (store, resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
  };
}

async function initStorageBackend() {
  if (navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory();
    const appRoot = await root.getDirectoryHandle(STORAGE_ROOT, { create: true });
    state.storage = createOPFSBackend(appRoot);
    if (ui.storageBackendText) ui.storageBackendText.textContent = 'Storage backend: OPFS';
    return;
  }

  state.storage = createIDBBackend();
  if (ui.storageBackendText) ui.storageBackendText.textContent = 'Storage backend: IndexedDB fallback';
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !ui.offlineText) {
    return;
  }

  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        ui.offlineText.textContent = 'Offline shell ready. Imported game data stays outside the service worker cache.';
        return;
      }
      if (state.engineStarted && !state.runtimeExited) {
        ui.offlineText.textContent = 'Update installed. Exit to the launcher to load it.';
        return;
      }
      if (!state.serviceWorkerReloading) {
        state.serviceWorkerReloading = true;
        location.reload();
      }
    });
    const registration = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      updateViaCache: 'none',
    });
    state.serviceWorkerRegistration = registration;
    if (navigator.serviceWorker.controller) {
      ui.offlineText.textContent = 'Offline shell ready. Imported game data stays outside the service worker cache.';
    } else if (registration.active || registration.installing || registration.waiting) {
      ui.offlineText.textContent = 'Offline shell installing… reload once to let it take control of this tab.';
    } else {
      ui.offlineText.textContent = 'Installing offline shell… keep this tab open until the status changes.';
    }
  } catch (error) {
    ui.offlineText.textContent = `Offline shell unavailable: ${error.message}`;
  }
}

function checkForServiceWorkerUpdate() {
  state.serviceWorkerRegistration?.update().catch((error) => {
    console.warn('Service worker update check failed', error);
  });
}

async function ensureEngineScriptLoaded() {
  if (state.runtimeLoaded || globalThis.__HEXENWAIL_EMSCRIPTEN_SCRIPT_EMBEDDED) {
    state.runtimeLoaded = true;
    return;
  }

  /* Each Emscripten .js file locates its own .wasm sibling by basename.
   * Log the choice so a bug report shows which bundle was in use. */
  const useNitro = state.preferences.renderer === 'nitro';
  const scriptUrl = useNitro ? './hexenwail-nitro.js' : './hexenwail.js';
  logToConsole('[launcher]', `Loading engine bundle: ${scriptUrl} (renderer=${state.preferences.renderer})`);

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.defer = true;
    script.onload = () => {
      state.runtimeLoaded = true;
      resolve();
    };
    script.onerror = () => {
      const detail = useNitro
          ? `Failed to load ${scriptUrl}. The WebGlideNitro bundle is missing from this artifact.`
            + ' Open the "Renderer" card, switch to "Software + WebGPU presentation",'
            + ' and the launcher will reload with the software renderer.'
        : `Failed to load ${scriptUrl}. Build the WASM target before serving this directory.`;
      reject(new Error(detail));
    };
    document.head.append(script);
  });
}

function bindUi() {
  Object.assign(ui, {
    canvas: document.getElementById('canvas'),
    statusPanel: document.getElementById('status-panel'),
    statusText: document.getElementById('status-text'),
    progressText: document.getElementById('progress-text'),
    runtimeLog: document.getElementById('runtime-log'),
    importMessage: document.getElementById('import-message'),
    rejectedList: document.getElementById('rejected-list'),
    launchButton: document.getElementById('launch-button'),
    exitButton: document.getElementById('exit-button'),
    importButton: document.getElementById('import-button'),
    directoryButton: document.getElementById('directory-button'),
    fullscreenButton: document.getElementById('fullscreen-button'),
    clearButton: document.getElementById('clear-button'),
    fileInput: document.getElementById('file-input'),
    saveFileInput: document.getElementById('save-file-input'),
    exportSavesButton: document.getElementById('export-saves-button'),
    importSavesButton: document.getElementById('import-saves-button'),
    saveImportMode: document.getElementById('save-import-mode'),
    saveMessage: document.getElementById('save-message'),
    directoryInput: document.getElementById('directory-input'),
    dropZone: document.getElementById('drop-zone'),
    viewport: document.querySelector('.viewport'),
    storageText: document.getElementById('storage-text'),
    storageBackendText: document.getElementById('storage-backend-text'),
    offlineText: document.getElementById('offline-text'),
    requirementsText: document.getElementById('requirements-text'),
    pointerLockHint: document.getElementById('pointer-lock-hint'),
    touchControlsSetting: document.getElementById('touch-controls-setting'),
    handednessSetting: document.getElementById('handedness-setting'),
    lookSensitivitySetting: document.getElementById('look-sensitivity-setting'),
    gyroAimSetting: document.getElementById('gyro-aim-setting'),
    gyroSensitivitySetting: document.getElementById('gyro-sensitivity-setting'),
    gyroInvertYSetting: document.getElementById('gyro-invert-y-setting'),
    gyroMessage: document.getElementById('gyro-message'),
    perfSetting: document.getElementById('perf-setting'),
    perfMessage: document.getElementById('perf-message'),
    perfOutput: document.getElementById('perf-output'),
    perfCopyButton: document.getElementById('perf-copy-button'),
    rendererSetting: document.getElementById('renderer-setting'),
    rendererMessage: document.getElementById('renderer-message'),
    phoneHint: document.getElementById('phone-hint'),
    phoneControlsRoot: document.getElementById('phone-controls'),
    phoneMenuButton: document.getElementById('phone-menu-button'),
    phoneOverlay: document.getElementById('phone-overlay'),
    phoneResumeButton: document.getElementById('phone-resume-button'),
    phoneEscapeButton: document.getElementById('phone-escape-button'),
    phoneExitButton: document.getElementById('phone-exit-button'),
    windowedButton: document.getElementById('windowed-button'),
  });
  appendRuntimeLog('[launcher]', state.lastStatus);
  if (state.perfReport) renderPerfReport();

  state.phoneControls = new PhoneControls(ui.phoneControlsRoot, {
    key: engineKey,
    look: engineLook,
  }, { lookSensitivity: state.preferences.lookSensitivity });
  state.phoneControls.attach();
  state.gyroAim = new GyroAim({
    look: engineGyroLook,
    /* Phone motion is independent from the touch overlay: a connected
     * controller is a valid way to combine gyro aim with an on-pad motion
     * sensor, and the menu guard still keeps it out of the launcher flow. */
    deviceActive: () => gyroGameplayActive(),
    gamepadActive: () => gyroGameplayActive() && state.gamepadConnected,
  }, { sensitivity: state.preferences.gyroSensitivity });
  addEventListener('hexenwailtouchmode', (event) => {
    const menu = Boolean(event.detail?.menu);
    if ((document.body.dataset.touchMenu === 'true') !== menu) {
      releasePhoneInputs();
    }
    document.body.dataset.touchMenu = menu ? 'true' : 'false';
  });
  /* iOS Safari still tries to zoom the page on double-tap and pinch gestures
   * once the game owns the surface. Consume them while the engine is running so
   * the viewport behaves like a game screen instead of a browser page. */
  ui.viewport?.addEventListener('dblclick', (event) => event.preventDefault());
  ui.viewport?.addEventListener('touchstart', suppressBrowserZoom, { passive: false });
  ui.viewport?.addEventListener('touchmove', suppressBrowserZoom, { passive: false });
  ui.viewport?.addEventListener('touchend', suppressBrowserZoom, { passive: false });
  document.addEventListener('gesturestart', suppressBrowserZoom, { passive: false });
  document.addEventListener('gesturechange', suppressBrowserZoom, { passive: false });
  document.addEventListener('gestureend', suppressBrowserZoom, { passive: false });

  ui.importButton?.addEventListener('click', () => ui.fileInput?.click());
  ui.directoryButton?.addEventListener('click', () => ui.directoryInput?.click());
  ui.fileInput?.addEventListener('change', async (event) => {
    await handleImportedFiles(event.target.files);
    event.target.value = '';
  });
  ui.directoryInput?.addEventListener('change', async (event) => {
    await handleImportedFiles(event.target.files);
    event.target.value = '';
  });
  ui.launchButton?.addEventListener('click', () => {
    if (state.runtimeExited) {
      returnToLauncher().catch((error) => setStatus(`Exit failed: ${error.message}`, 'error'));
    } else {
      startEngineFromUserAction();
    }
  });
  ui.exitButton?.addEventListener('click', () => {
    returnToLauncher().catch((error) => setStatus(`Exit failed: ${error.message}`, 'error'));
  });
  ui.clearButton?.addEventListener('click', () => clearImportedData());
  ui.exportSavesButton?.addEventListener('click', () => exportSaves());
  ui.importSavesButton?.addEventListener('click', () => ui.saveFileInput?.click());
  ui.saveFileInput?.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (file) await importSaveBundle(file);
    event.target.value = '';
  });
  ui.fullscreenButton?.addEventListener('click', () => toggleFullscreenPlay());
  ui.perfCopyButton?.addEventListener('click', () => copyPerfReport());
  ui.canvas?.addEventListener('click', tryCaptureInput);
  ui.phoneMenuButton?.addEventListener('click', togglePhoneMenuButton);
  ui.phoneResumeButton?.addEventListener('click', closePhoneOverlay);
  ui.phoneEscapeButton?.addEventListener('click', () => {
    engineKey(PHONE_CONTROL_KEYCODES.menu, true);
    engineKey(PHONE_CONTROL_KEYCODES.menu, false);
    closePhoneOverlay();
  });
  ui.phoneExitButton?.addEventListener('click', () => {
    returnToLauncher().catch((error) => setStatus(`Exit failed: ${error.message}`, 'error'));
  });
  ui.windowedButton?.addEventListener('click', () => {
    closePhoneOverlay();
    leaveFullscreenPlay().catch((error) => appendRuntimeLog('[launcher]', `Leaving fullscreen failed: ${error.message}`));
  });
  ui.touchControlsSetting?.addEventListener('change', () => {
    state.preferences.touchControls = ui.touchControlsSetting.value;
    savePreferences();
    applyPreferences();
  });
  ui.handednessSetting?.addEventListener('change', () => {
    state.preferences.handedness = ui.handednessSetting.value;
    savePreferences();
    applyPreferences();
  });
  ui.lookSensitivitySetting?.addEventListener('input', () => {
    state.preferences.lookSensitivity = Number(ui.lookSensitivitySetting.value);
    savePreferences();
    applyPreferences();
  });
  ui.gyroAimSetting?.addEventListener('change', () => {
    state.preferences.gyroAim = ui.gyroAimSetting.value === 'on';
    savePreferences();
    applyPreferences();
    if (state.preferences.gyroAim) {
      requestGyroPermission();
    } else {
      setGyroMessage('Gyro aim is off.');
    }
  });
  ui.gyroSensitivitySetting?.addEventListener('input', () => {
    state.preferences.gyroSensitivity = Number(ui.gyroSensitivitySetting.value);
    savePreferences();
    applyPreferences();
  });
  ui.gyroInvertYSetting?.addEventListener('change', () => {
    state.preferences.gyroInvertY = ui.gyroInvertYSetting.checked;
    savePreferences();
    applyPreferences();
  });
  /* Renderer selection: the engine script is loaded exactly once during
   * init(), so a change here can only be honoured on the next launcher
   * load. If nothing is currently playing, reload the page automatically
   * (persisting the choice first). If the engine is already running, do
   * *not* reload the tab out from under it — persist the preference and
   * tell the player how to apply it. state.engineStarted / body's
   * data-engine-state are the same signal handleEngineQuit() sets, so a
   * finished game (runtimeExited) counts as "not running" here. */
  ui.rendererSetting?.addEventListener('change', () => {
    const next = ui.rendererSetting.value === 'nitro' ? 'nitro' : 'software';
    if (next === state.preferences.renderer) return;
    state.preferences.renderer = next;
    savePreferences();
    applyPreferences();
    const label = next === 'nitro'
      ? 'WebGlideNitro primary native WebGPU renderer'
      : 'software renderer with WebGPU presentation';
    appendRuntimeLog('[launcher]', `Renderer preference changed to ${next} (${label}).`);
    const enginePlaying = state.engineStarted && !state.runtimeExited;
    if (enginePlaying) {
      if (ui.rendererMessage) {
        ui.rendererMessage.textContent = `Renderer change queued: ${label}. Exit to the launcher (☰) to reload with the new bundle.`;
      }
      return;
    }
    if (ui.rendererMessage) {
      ui.rendererMessage.textContent = `Reloading launcher to apply the ${label}…`;
    }
    /* Give the runtime log and the reload-hint one paint before the
     * navigation blows the launcher DOM away. */
    setTimeout(() => location.reload(), 60);
  });
  ui.perfSetting?.addEventListener('change', () => {
    state.preferences.perfCapture = ui.perfSetting.value === '1';
    savePreferences();
    applyPreferences();
    appendRuntimeLog('[launcher]', `Performance capture ${state.preferences.perfCapture ? 'enabled' : 'disabled'}.`);
    if (ui.perfMessage) {
      ui.perfMessage.textContent = state.preferences.perfCapture
        ? 'Raw performance capture enabled. It applies on the next launch.'
        : 'Performance capture disabled.';
    }
  });

  for (const query of [
    PHONE_VIEWPORT_QUERY,
    /* Listened to explicitly: pointer capability is no longer part of
     * PHONE_VIEWPORT_QUERY, so it needs its own subscription to keep the
     * touch-control decision live. */
    '(any-pointer: coarse)',
    '(any-pointer: fine)',
    '(any-hover: hover)',
  ]) {
    matchMedia(query).addEventListener('change', () => updateTouchOnlyEnvironment());
  }

  addEventListener('gamepadconnected', () => {
    state.gamepadConnected = true;
    updateTouchOnlyEnvironment(true);
  });
  addEventListener('gamepaddisconnected', () => {
    state.gamepadConnected = false;
    updateTouchOnlyEnvironment();
  });
  addEventListener('hexenwailperf', handlePerfReport);
  addEventListener('keydown', (event) => {
    if (event.isTrusted !== false) updateTouchOnlyEnvironment(true);
  });
  addEventListener('wheel', () => updateTouchOnlyEnvironment(true), { passive: true });
  addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') {
      updateTouchOnlyEnvironment(true);
    }
  }, { passive: true });

  if (ui.dropZone) {
    for (const eventName of ['dragenter', 'dragover']) {
      ui.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        ui.dropZone.dataset.drag = 'true';
      });
    }
    for (const eventName of ['dragleave', 'drop']) {
      ui.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        ui.dropZone.dataset.drag = 'false';
      });
    }
    ui.dropZone.addEventListener('drop', async (event) => {
      await handleImportedFiles(event.dataTransfer?.files ?? []);
    });
  }
}

function bindBootCallbacks() {
  const boot = getBoot();
  const Module = getModule();
  const previousOnRuntimeInitialized = Module.onRuntimeInitialized;
  Module.canvas = ui.canvas;
  Module.arguments = getEngineArguments();
  Module.noInitialRun = true;
  Module.locateFile = (path) => new URL(path, document.baseURI).toString();
  Module.print = (text) => {
    logToConsole('[hexenwail]', text, false);
    boot.lastPrint = text;
  };
  Module.printErr = (text) => {
    logToConsole('[hexenwail:error]', text, true);
  };
  for (const entry of boot.earlyLog ?? []) {
    logToConsole(entry.prefix, entry.message, entry.error);
  }
  boot.earlyLog = [];
  Module.setStatus = (text) => {
    if (text) {
      setStatus(text);
    }
  };
  Module.monitorRunDependencies = (left) => {
    if (left > 0) {
      setStatus(`Loading engine runtime… ${left} remaining`);
    }
  };
  Module.onRuntimeInitialized = async () => {
    previousOnRuntimeInitialized?.();
    state.runtimeReady = true;
    boot.runtimeInitialized = true;
    setStatus('Engine runtime ready. Restoring persistent data…');
    await loadStoredFilesIntoRuntime();
    setStatus('Engine ready. Start the game when ready.');
    updateLaunchState();
  };
  boot.onQuit = (detail) => handleEngineQuit(detail?.kind ?? 'quit', detail?.message ?? '');

  if (boot.runtimeInitialized) {
    queueMicrotask(async () => {
      state.runtimeReady = true;
      await loadStoredFilesIntoRuntime();
      setStatus('Engine ready. Start the game when ready.');
      updateLaunchState();
    });
  }
}

async function init() {
  loadPreferences();
  try {
    state.perfReport = sessionStorage.getItem(PERF_REPORT_KEY) ?? '';
  } catch {
    state.perfReport = '';
  }
  bindUi();
  /* Both renderer bundles take the WebGPU device from here rather than opening one
   * of their own: the canvas can only ever have a single configured
   * context, and the launcher is what owns the canvas. */
  const report = await probeWebGPU({ canvas: ui.canvas });
  if (report.ok) {
    const limits = report.handoff.limits;
    report.handoff.onLost = (info) => {
      const detail = info?.message ? `: ${info.message}` : '';
      logToConsole('[renderer:error]',
        `WebGPU device lost (${info?.reason ?? 'unknown'})${detail}`, true);
      setStatus('WebGPU device lost. Reload the launcher to recover.', 'error');
    };
    getModule().hexenwailWebGPU = report.handoff;
    state.rendererReady = true;
    logToConsole('[renderer]', `WebGPU ${report.handoff.format}; `
      + `max2D=${limits.maxTextureDimension2D}; layers=${limits.maxTextureArrayLayers}; `
      + `bindGroups=${limits.maxBindGroups}; maxBuffer=${limits.maxBufferSize}`);
  } else {
    state.rendererReady = false;
    setEngineState('fatal');
    logToConsole('[renderer:error]', report.reason, true);
    setStatus(`WebGPU initialization failed: ${report.reason}`, 'error');
  }
  updateTouchOnlyEnvironment();
  bindBootCallbacks();
  updateLaunchState();
  setImportMessage('Import files, a directory, or a ZIP archive. All processing stays in your browser.');
  await requestPersistentStorage();
  await initStorageBackend();
  state.storageReady = true;
  await updateStorageIndicator();
  await registerServiceWorker();
  await ensureEngineScriptLoaded();
  if (state.runtimeReady) {
    await loadStoredFilesIntoRuntime();
    setStatus('Engine ready. Start the game when ready.');
    updateLaunchState();
  }

  setInterval(() => {
    syncRuntimeToStorage().catch((error) => console.warn('Save sync failed', error));
  }, SAVE_SYNC_INTERVAL_MS);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      releasePhoneInputs();
      flushEngineConfig();
      syncRuntimeToStorage().catch((error) => console.warn('Save sync failed', error));
    } else {
      checkForServiceWorkerUpdate();
    }
  });
  addEventListener('pageshow', checkForServiceWorkerUpdate);
  addEventListener('orientationchange', () => {
    releasePhoneInputs();
    scheduleCanvasResize();
  });
  addEventListener('resize', scheduleCanvasResize);
  /* The canvas backing store is sized from the game surface, so every
   * fullscreen transition (including the browser's own Esc/edge gesture)
   * has to re-measure or the engine keeps rendering at the old size into a
   * black screen. */
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.addEventListener('pointerlockchange', () => {
    setPointerLockHint(document.pointerLockElement
      ? 'Mouse captured. Press Esc (or ` on an iPad keyboard) to release it through the game menu.'
      : 'Starting the game hides the launcher chrome and asks the browser for fullscreen. Press ☰ in-game to leave fullscreen or return to the launcher.');
  });
  globalThis.visualViewport?.addEventListener('resize', scheduleCanvasResize);
  globalThis.visualViewport?.addEventListener('scroll', scheduleCanvasResize);
  addEventListener('hexenwailquit', (event) => {
    handleEngineQuit(event.detail?.kind ?? 'quit', event.detail?.message ?? '').catch((error) => console.warn(error));
  });
  // 'pagehide' fires on tab close, app switch (iPadOS Safari/PWA backgrounding),
  // and bfcache eviction; 'beforeunload' and 'freeze' are extra safety nets so
  // savegames written just before the runtime is suspended are not lost.
  addEventListener('pagehide', () => {
    flushEngineConfig();
    syncRuntimeToStorage().catch((error) => console.warn('Save sync failed', error));
  });
  addEventListener('beforeunload', () => {
    syncRuntimeToStorage().catch((error) => console.warn('Save sync failed', error));
  });
  document.addEventListener('freeze', () => {
    syncRuntimeToStorage().catch((error) => console.warn('Save sync failed', error));
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    setStatus(`Unhandled error: ${event.message}`, 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    setStatus(`Unhandled promise rejection: ${event.reason?.message ?? event.reason}`, 'error');
  });
  init().catch((error) => {
    console.error(error);
    setStatus(error.message, 'error');
    setImportMessage(error.message, 'error');
  });
}
