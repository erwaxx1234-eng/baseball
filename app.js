const release = "bb97-static-8";
const saveRoot = "/bb97-saves";
const configRoot = "/bb97-settings-v4";
const gameFiles = [0, 1, 2, 4, 9].map(number => `game/baseball.he${number}`);

function validateAssets(value) {
  if (value?.version !== 7 || !Array.isArray(value.files) || value.files.length > 40) throw new Error("invalid asset manifest");
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!file || typeof file.path !== "string" || !/^(?:game|runtime|data)\/[a-z0-9_./-]+$/.test(file.path) || file.path.split("/").some(part => !part || part.startsWith(".")) || names.has(file.path)) throw new Error("invalid or duplicate asset path");
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("invalid asset size or checksum");
    if (file.transport !== undefined) {
      const t = file.transport;
      if (!t || !["gzip", "identity"].includes(t.encoding) || !Number.isSafeInteger(t.size) || t.size < 1 || t.size > 100 * 1024 * 1024) throw new Error("invalid asset transport");
      const validTransportPath = path => /^assets\/(?:engine|data|game)\/[a-z0-9_.\/-]+(?:\.pack|\.js|\.json|\.part\d+)$/.test(path);
      if (t.parts !== undefined) {
        if (!Array.isArray(t.parts) || t.parts.length < 2 || t.parts.length > 32) throw new Error("invalid asset parts");
        let packed = 0;
        const partNames = new Set();
        for (const part of t.parts) {
          if (!part || !validTransportPath(part.path) || partNames.has(part.path) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > 20_000_000) throw new Error("invalid asset part");
          partNames.add(part.path);
          packed += part.size;
        }
        if (t.path !== undefined || packed !== t.size) throw new Error("invalid split transport");
      } else if (!validTransportPath(t.path)) throw new Error("invalid asset transport path");
      if (file.path === "runtime/scummvm.js" && (t.parts || t.encoding !== "identity" || !t.path.endsWith(".js") || t.size !== file.size)) throw new Error("invalid loader transport");
    }
    names.add(file.path);
    total += file.size;
  }
  for (const name of [...gameFiles, "runtime/scummvm.js", "runtime/scummvm.wasm", "data/plugins/libscumm.so"]) {
    if (!names.has(name)) throw new Error(`missing asset: ${name}`);
  }
  if (value.totalBytes !== total || total > 512 * 1024 * 1024) throw new Error("invalid asset total");
  value.downloadBytes = value.files.reduce((sum, file) => sum + (file.transport?.size ?? file.size), 0);
  return value;
}

function assetUrl(file, base) {
  if (file.transport?.parts) throw new Error(`split asset needs part urls: ${file.path}`);
  const url = new URL(file.transport?.path || file.path, base);
  url.searchParams.set("v", file.sha256.slice(0, 16));
  return url.href;
}

function assetPartUrls(file, base) {
  if (!file.transport?.parts) return [assetUrl(file, base)];
  return file.transport.parts.map((part, index) => {
    const url = new URL(part.path, base);
    url.searchParams.set("v", `${file.sha256.slice(0, 16)}-${index + 1}`);
    return url.href;
  });
}

function engineFile(name, base) {
  const leaf = name.split("/").pop();
  if (!/^[a-z0-9_][a-z0-9_.-]*$/.test(leaf)) throw new Error("invalid engine filename");
  return new URL(leaf.endsWith(".so") ? `data/plugins/${leaf}` : `runtime/${leaf}`, base).href;
}

function gameConfig() {
  return `[scummvm]\ngui_theme=builtin\ngfx_mode=normal\nfullscreen=false\naspect_ratio=false\nfiltering=false\nconfirm_exit=false\nsavepath=${saveRoot}\n\n[bb97]\nengineid=scumm\ngameid=baseball\npath=/game\nplatform=windows\nlanguage=en\nsavepath=${saveRoot}\n`;
}

function engineArguments() {
  return [`--config=${configRoot}/scummvm.ini`, "--gfx-mode=normal", "bb97"];
}

async function mapLimit(items, limit, visit) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid concurrency limit");
  let cursor = 0;
  let failed = false;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { await visit(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
}

function safeSaveName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 240 && name.split("/").every(part => /^[a-z0-9][a-z0-9_. -]{0,119}$/i.test(part) && !part.endsWith(".") && !part.endsWith(" "));
}

function encodeBytes(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}

function decodeBackup(text) {
  if (typeof text !== "string" || text.length > 24 * 1024 * 1024) throw new Error("save backup is too large");
  const value = JSON.parse(text);
  if (value?.format !== "bb97-web-backup" || value.version !== 1 || !Array.isArray(value.files) || value.files.length > 200) throw new Error("invalid save backup");
  const names = new Set();
  let total = 0;
  const files = value.files.map(file => {
    if (!file || !safeSaveName(file.name) || names.has(file.name.toLowerCase()) || typeof file.base64 !== "string" || (file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))) throw new Error("invalid backup file");
    names.add(file.name.toLowerCase());
    const binary = atob(file.base64);
    if (btoa(binary) !== file.base64) throw new Error("invalid backup encoding");
    total += binary.length;
    if (total > 16 * 1024 * 1024) throw new Error("save backup is too large");
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return {name: file.name, bytes};
  });
  for (const name of names) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (names.has(parts.join("/"))) throw new Error("backup file conflicts with a directory");
    }
  }
  return files;
}

function saveKey(base) {
  const path = new URL("./", base).pathname;
  return path === "/" ? "current" : `current:${path}`;
}

async function download(file, urls, {fetcher = fetch, signal, progress = () => {}, attempts = 3, idleMs = 45000} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("invalid retry count");
  const list = Array.isArray(urls) ? urls : [urls];
  const parts = file.transport?.parts || null;
  if (parts && list.length !== parts.length) throw new Error(`wrong part count: ${file.path}`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, {once: true});
    if (signal?.aborted) abort();
    let timer;
    let reader;
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`download stalled: ${file.path}`)), idleMs);
    };
    try {
      controller.signal.throwIfAborted();
      progress(0);
      resetTimeout();
      let packedTransferred = 0;
      const packedStream = new ReadableStream({
        async start(streamController) {
          try {
            for (let index = 0; index < list.length; index++) {
              const expected = parts ? parts[index].size : file.transport?.size ?? file.size;
              const response = await fetcher(list[index], {signal: controller.signal, cache: attempt ? "reload" : "default"});
              if (!response.ok) throw new Error(`${file.path}: server returned ${response.status}`);
              const contentLength = Number(response.headers.get("content-length"));
              if (Number.isFinite(contentLength) && contentLength !== expected) throw new Error(`wrong packed size: ${file.path}`);
              const partReader = response.body?.getReader();
              let partTransferred = 0;
              if (partReader) {
                try {
                  while (true) {
                    const {done, value} = await partReader.read();
                    controller.signal.throwIfAborted();
                    if (done) break;
                    partTransferred += value.byteLength;
                    packedTransferred += value.byteLength;
                    if (partTransferred > expected || packedTransferred > (file.transport?.size ?? file.size)) throw new Error(`wrong packed size: ${file.path}`);
                    resetTimeout();
                    progress(packedTransferred);
                    streamController.enqueue(value);
                  }
                } finally { partReader.releaseLock(); }
              } else {
                const value = new Uint8Array(await response.arrayBuffer());
                partTransferred = value.byteLength;
                packedTransferred += value.byteLength;
                if (partTransferred > expected || packedTransferred > (file.transport?.size ?? file.size)) throw new Error(`wrong packed size: ${file.path}`);
                resetTimeout();
                progress(packedTransferred);
                streamController.enqueue(value);
              }
              if (partTransferred !== expected) throw new Error(`incomplete packed part: ${file.path}`);
            }
            if (packedTransferred !== (file.transport?.size ?? file.size)) throw new Error(`incomplete packed download: ${file.path}`);
            streamController.close();
          } catch (error) { streamController.error(error); }
        },
        cancel(reason) { controller.abort(reason); }
      });
      let stream = packedStream;
      if (file.transport?.encoding === "gzip") {
        if (!globalThis.DecompressionStream) throw new Error("this browser needs streaming gzip support; update your browser");
        stream = stream.pipeThrough(new DecompressionStream("gzip"));
      }
      const bytes = new Uint8Array(file.size);
      let offset = 0;
      reader = stream.getReader();
      while (true) {
        const {done, value} = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        if (offset + value.length > bytes.length) throw new Error(`wrong file size: ${file.path}`);
        bytes.set(value, offset);
        offset += value.length;
        resetTimeout();
        if (!file.transport || file.transport.encoding === "identity") progress(offset);
      }
      clearTimeout(timer);
      controller.signal.throwIfAborted();
      if (offset !== file.size) throw new Error(`incomplete download: ${file.path}`);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
      controller.signal.throwIfAborted();
      if (hash !== file.sha256) throw new Error(`checksum mismatch: ${file.path}`);
      return bytes;
    } catch (error) {
      clearTimeout(timer);
      if (reader) await reader.cancel().catch(() => {});
      if (signal?.aborted) throw signal.reason || error;
      if (attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reader?.releaseLock();
    }
  }
  throw new Error("download failed");
}

const empty = () => ({format: "bb97-web-backup", version: 1, files: []});

function canonicalBackup(backup) {
  const files = decodeBackup(JSON.stringify(backup));
  return {format: "bb97-web-backup", version: 1, files: files.map(file => ({name: file.name, base64: encodeBytes(file.bytes)})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)};
}

function openDatabase(idb, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    if (!idb) { reject(new Error("browser storage is unavailable")); return; }
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error("browser storage timed out; close other game tabs")); }, 10000);
    let request;
    try { request = idb.open(name, version); }
    catch (error) { clearTimeout(timer); reject(error); return; }
    request.onupgradeneeded = event => {
      if (upgrade) upgrade(event.target.result, event.target.transaction);
      else event.target.transaction.abort();
    };
    request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error("browser save database is blocked by another tab")); };
    request.onerror = () => { clearTimeout(timer); if (!settled) reject(request.error); };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function readRecord(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    let value;
    tx.objectStore(store).get(key).onsuccess = event => { value = event.target.result; };
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error("browser save read failed"));
  });
}

async function backupHash(backup) {
  const bytes = new TextEncoder().encode(JSON.stringify(backup));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRecord(record) {
  if (!record) return {revision: 0, backup: empty()};
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error("invalid browser save revision");
  const backup = canonicalBackup(record.backup);
  if (record.sha256 && record.sha256 !== await backupHash(backup)) throw new Error("browser save integrity check failed; do not clear site data");
  return {...record, backup};
}

async function openBrowserStore(idb = globalThis.indexedDB, {key = "current"} = {}) {
  if (typeof key !== "string" || !key.startsWith("current") || key.length > 4096) throw new Error("invalid save scope");
  const db = await openDatabase(idb, "bb97-snapshots-v5", 1, database => database.createObjectStore("saves"));
  const prefix = `history:${encodeURIComponent(key)}:`;
  let closed = false;
  let queue = Promise.resolve();
  let initial;
  let legacy;
  try {
    const record = await readRecord(db, "saves", key);
    initial = await checkRecord(record);
    if (!record && key !== "current") legacy = await readRecord(db, "saves", "current");
    if (legacy) legacy = await checkRecord(legacy);
  } catch (error) { db.close(); throw error; }
  let revision = initial.revision;
  async function commit(value) {
    if (closed) throw new Error("browser save storage is closed; export a backup before reloading");
    const backup = canonicalBackup(value);
    const sha256 = await backupHash(backup);
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction("saves", "readwrite", {durability: "strict"}); }
      catch { tx = db.transaction("saves", "readwrite"); }
      const store = tx.objectStore("saves");
      let next;
      let failure;
      const fail = error => { failure = error; tx.abort(); };
      store.get(key).onsuccess = event => {
        try {
          const current = event.target.result || {revision: 0, backup: empty()};
          if (!Number.isSafeInteger(current.revision) || current.revision < 0) throw new Error("invalid stored save revision");
          const currentBackup = canonicalBackup(current.backup);
          if (JSON.stringify(currentBackup) === JSON.stringify(backup)) { next = current.revision; return; }
          if (current.revision !== revision) {
            const error = new Error("another tab changed these saves; export a backup before reloading");
            error.conflict = true;
            throw error;
          }
          if (revision >= Number.MAX_SAFE_INTEGER) throw new Error("save revision limit reached");
          next = revision + 1;
          const record = {revision: next, backup, sha256, updated: Date.now()};
          store.put(record, key);
          store.put(record, prefix + String(next).padStart(16, "0"));
          let count = 0;
          let bytes = 0;
          store.openCursor(null, "prev").onsuccess = event => {
            const cursor = event.target.result;
            if (!cursor) return;
            if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
              count++;
              bytes += JSON.stringify(cursor.value).length;
              if (count > 20 || (bytes > 32 * 1024 * 1024 && count > 1)) cursor.delete();
            }
            cursor.continue();
          };
        } catch (error) { fail(error); }
      };
      tx.oncomplete = () => { revision = next; resolve(next); };
      tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error("browser save transaction failed"));
    });
  }
  const backend = {
    kind: "browser", initial,
    save(value) {
      const snapshot = canonicalBackup(value);
      const next = queue.then(() => commit(snapshot));
      queue = next.catch(() => {});
      return next;
    },
    async history() {
      return new Promise((resolve, reject) => {
        const tx = db.transaction("saves", "readonly");
        const records = [];
        tx.objectStore("saves").openCursor(null, "prev").onsuccess = event => {
          const cursor = event.target.result;
          if (!cursor) return;
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) records.push({revision: cursor.value.revision, updated: cursor.value.updated});
          cursor.continue();
        };
        tx.oncomplete = () => resolve(records);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error("could not read save history"));
      });
    },
    async exportRevision(number) {
      if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid save revision");
      const record = await readRecord(db, "saves", prefix + String(number).padStart(16, "0"));
      if (!record) throw new Error("save revision is not available");
      return (await checkRecord(record)).backup;
    },
    close() { closed = true; db.close(); }
  };
  if (legacy?.backup.files.length) {
    try {
      const next = await backend.save(legacy.backup);
      backend.initial = {revision: next, backup: legacy.backup};
    } catch (error) { backend.close(); throw error; }
  }
  return backend;
}

async function readLegacySaves(idb = globalThis.indexedDB) {
  if (!idb) return empty();
  if (idb.databases) {
    const databases = await idb.databases();
    if (!databases.some(db => db.name === "/bb97-saves")) return empty();
  }
  let db;
  try { db = await openDatabase(idb, "/bb97-saves", 21); }
  catch (error) { if (error?.name === "AbortError") return empty(); throw error; }
  try {
    if (!db.objectStoreNames.contains("FILE_DATA")) return empty();
    const files = await new Promise((resolve, reject) => {
      const tx = db.transaction("FILE_DATA", "readonly");
      const files = [];
      tx.objectStore("FILE_DATA").openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor) return;
        const name = String(cursor.key).replace(/^\/bb97-saves\//, "");
        const entry = cursor.value;
        if (safeSaveName(name) && (entry.mode & 61440) === 32768 && entry.contents) {
          const bytes = new Uint8Array(entry.contents);
          files.push({name, base64: encodeBytes(bytes)});
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(files);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error("could not read previous saves"));
    });
    return canonicalBackup({format: "bb97-web-backup", version: 1, files});
  } finally { db.close(); }
}

function exportBackup(fs, exclude = new Set()) {
  const files = [];
  let size = 0;
  function walk(folder, prefix = "") {
    for (const name of fs.readdir(folder).sort()) {
      if (name === "." || name === "..") continue;
      const relative = prefix + name;
      if (exclude.has(relative)) continue;
      if (!safeSaveName(relative)) throw new Error(`unsafe save filename: ${relative}`);
      const path = `${folder}/${name}`;
      const stat = fs.lstat(path);
      if (fs.isDir(stat.mode)) walk(path, `${relative}/`);
      else if (fs.isFile(stat.mode)) {
        size += stat.size;
        if (size > 16 * 1024 * 1024 || files.length >= 200) throw new Error("save backup is too large");
        files.push({name: relative, base64: encodeBytes(fs.readFile(path))});
      } else throw new Error("unsupported file in the save folder");
    }
  }
  walk(saveRoot);
  return JSON.stringify({format: "bb97-web-backup", version: 1, files});
}

function loadBackup(fs, text) {
  const files = decodeBackup(text);
  fs.mkdirTree(saveRoot);
  for (const file of files) {
    const path = `${saveRoot}/${file.name}`;
    fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
    fs.writeFile(path, file.bytes);
  }
  return files.length;
}

function observeSaveWrites(fs, changed) {
  const originals = new Map();
  const writers = new Set();
  const belongs = path => typeof path === "string" && path.startsWith(saveRoot + "/");
  function wrap(name, replacement) {
    const original = fs[name];
    if (typeof original !== "function") return;
    originals.set(name, original);
    fs[name] = replacement(original.bind(fs));
  }
  wrap("open", original => (...args) => {
    const stream = original(...args);
    if (belongs(stream.path) && (stream.flags & 3) !== 0) writers.add(stream);
    return stream;
  });
  wrap("close", original => stream => {
    const tracked = writers.has(stream);
    const result = original(stream);
    if (tracked) { writers.delete(stream); changed(); }
    return result;
  });
  for (const name of ["rename", "unlink", "rmdir", "truncate"]) wrap(name, original => (...args) => {
    const result = original(...args);
    if (belongs(args[0]) || (name === "rename" && belongs(args[1]))) changed();
    return result;
  });
  return {
    hasOpenWriters: () => writers.size > 0,
    openPaths: () => new Set([...writers].map(stream => {
      const path = stream.node && fs.getPath ? fs.getPath(stream.node) : stream.path;
      return path.slice(saveRoot.length + 1);
    })),
    writers: () => [...writers].map(stream => ({path: stream.path, flags: stream.flags, fd: stream.fd})),
    stop() { for (const [name, original] of originals) fs[name] = original; }
  };
}

function trackSaves(fs, backend, {onStatus = () => {}, onError = () => {}, delay = 150, retryMs = 3000} = {}) {
  let committed = exportBackup(fs);
  let dirty = false;
  let running;
  let timer;
  let stopped = false;
  let failure;
  let failures = 0;
  const watcher = observeSaveWrites(fs, () => {
    dirty = true;
    onStatus("saving");
    schedule(delay);
  });
  function schedule(ms) {
    if (stopped || timer || failure?.conflict) return;
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, ms);
  }
  async function commitChanges() {
    while (dirty && !stopped) {
      try {
        const snapshot = stableSnapshot();
        dirty = false;
        if (snapshot === committed) { failure = null; failures = 0; onStatus("saved"); continue; }
        onStatus("saving");
        await backend.save(JSON.parse(snapshot));
        committed = snapshot;
        failure = null;
        failures = 0;
        onStatus("saved");
      } catch (error) {
        dirty = true;
        failure = error;
        failures++;
        onError(error);
        schedule(Math.min(30000, retryMs * 2 ** Math.min(failures - 1, 3)));
        throw error;
      }
    }
  }
  function stableSnapshot() {
    const open = watcher.openPaths();
    const current = JSON.parse(exportBackup(fs, open));
    current.files.push(...JSON.parse(committed).files.filter(file => open.has(file.name)));
    current.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return JSON.stringify(current);
  }
  function flush() {
    if (stopped) return Promise.resolve();
    if (timer) { clearTimeout(timer); timer = null; }
    if (running) return running;
    if (!dirty) return Promise.resolve();
    running = commitChanges().finally(() => { running = null; });
    return running;
  }
  return {
    kind: backend.kind,
    history: () => backend.history?.() || Promise.resolve([]),
    exportRevision: number => backend.exportRevision(number),
    flush,
    isBusy: () => dirty || Boolean(running),
    export: stableSnapshot,
    getError: () => failure,
    diagnostics: () => ({dirty, running: Boolean(running), writers: watcher.writers()}),
    async restore(text) {
      if (watcher.hasOpenWriters()) throw new Error("the game is still writing a save");
      const backup = canonicalBackup(JSON.parse(text));
      await flush();
      const current = JSON.parse(exportBackup(fs));
      const merged = new Map(current.files.map(file => [file.name.toLowerCase(), file]));
      for (const file of backup.files) merged.set(file.name.toLowerCase(), file);
      const complete = canonicalBackup({format: "bb97-web-backup", version: 1, files: [...merged.values()]});
      await backend.save(complete);
      for (const file of current.files) if (!complete.files.some(item => item.name === file.name)) fs.unlink(`${saveRoot}/${file.name}`);
      loadBackup(fs, JSON.stringify(complete));
      committed = exportBackup(fs);
      dirty = false;
      return backup.files.length;
    },
    stop() { stopped = true; clearTimeout(timer); watcher.stop(); backend.close?.(); }
  };
}

async function initializeSaves(engine, {base, idb = globalThis.indexedDB, onStatus, onError, onWarning = () => {}, backend} = {}) {
  if (!backend) backend = await openBrowserStore(idb, {key: base ? saveKey(base) : "current"});
  engine.FS.mkdirTree(saveRoot);
  let initial = backend.initial.backup;
  if (backend.initial.revision === 0 && !initial.files.length) {
    try {
      const previous = await readLegacySaves(idb);
      if (previous.files.length) {
        await backend.save(previous);
        initial = previous;
        onWarning(`migrated ${previous.files.length} previous save files to ${backend.kind} storage`);
      }
    } catch (error) {
      throw new Error(`could not migrate previous saves: ${error.message}. close other game tabs and retry; existing saves were not changed.`);
    }
  }
  loadBackup(engine.FS, JSON.stringify(initial));
  return trackSaves(engine.FS, backend, {onStatus, onError});
}

async function restoreBackupBeforeStart(engine, text) {
  if (engine.bb97Saves) return engine.bb97Saves.restore(text);
  return loadBackup(engine.FS, text);
}

const steamNotice = "Warning: this re-release version contains patched game scripts,\nand therefore it might crash or not work properly for the time being.";

function acknowledgePatchedEdition(engine, notify = () => {}) {
  const imports = engine.bb97Imports;
  const modalName = "_ZN3GUI6Dialog8runModalEv";
  const names = [
    "_ZN3GUI13MessageDialogC1ERKN6Common9U32StringE",
    "_ZN3GUI13MessageDialogC1ERKN6Common9U32StringES4_S4_N8Graphics9TextAlignEPKcS4_"
  ];
  if (!imports || typeof imports[modalName] !== "function" || !names.some(name => typeof imports[name] === "function")) return false;
  const dialogs = new Set();
  let armed = true;
  function matches(pointer) {
    const heap = engine.bb97Heap();
    if (!Number.isInteger(pointer) || pointer < 0 || pointer % 4 || pointer + 8 > heap.byteLength) return false;
    const index = pointer >>> 2;
    const length = heap[index];
    const text = heap[index + 1];
    if (length !== steamNotice.length || text % 4 || text + (length + 1) * 4 > heap.byteLength) return false;
    for (let i = 0; i < length; i++) if (heap[(text >>> 2) + i] !== steamNotice.charCodeAt(i)) return false;
    return heap[(text >>> 2) + length] === 0;
  }
  for (const name of names) {
    const original = imports[name];
    if (typeof original !== "function") continue;
    const wrapped = (...args) => {
      dialogs.delete(args[0]);
      const result = original(...args);
      if (armed && matches(args[1])) dialogs.add(args[0]);
      return result;
    };
    wrapped.sig = original.sig;
    imports[name] = wrapped;
  }
  const original = imports[modalName];
  const wrapped = (...args) => {
    if (armed && dialogs.delete(args[0])) {
      armed = false;
      notify("acknowledged the patched-edition startup notice");
      return 0;
    }
    return original(...args);
  };
  wrapped.sig = original.sig;
  imports[modalName] = wrapped;
  return true;
}

const patchId = "steam-script-169-stack-v1";
const gameDataHash = "ca652752d9527dddb91229e6f434c208bbd07c339e7557bf578cf0fd9362a68b";
const scriptOffset = 30135415;
const scriptSize = 168;
const repairedOffsets = Object.freeze([0x33, 0x59, 0x7f]);
const originalScript = "53435250000000a803ac015d1c0001d107012e230005000000070b0201000100070b02010005c900007c03740100010e5d1d001a01d107012e230002000000070b0201000100070b02010005c900007c03740100030e5d1d001a01d107012e230004000000070b0201000100070b02010005c900007c03740100040e5d1d001a01d107012e230003000000070b0201000100070b02010005c900007c01d107012e2300000003c966";

function repairSteamScript(bytes, verifiedHash) {
  if (!(bytes instanceof Uint8Array) || verifiedHash !== gameDataHash || bytes.length !== 72964087) {
    throw new Error("this game-data version does not match the tested compatibility fix");
  }
  for (let i = 0; i < scriptSize; i++) {
    if ((bytes[scriptOffset + i] ^ 0x69) !== Number.parseInt(originalScript.slice(i * 2, i * 2 + 2), 16)) {
      throw new Error("the game script differs from the expected original; no patch was applied");
    }
  }
  for (const offset of repairedOffsets) bytes[scriptOffset + offset] = 0xbd ^ 0x69;
  return patchId;
}

const canvas = document.querySelector("#canvas");
const loading = document.querySelector("#loading");
const progress = document.querySelector("#progress");
const status = document.querySelector("#status");
const amount = document.querySelector("#amount");
const base = new URL("./", location.href);
const networkFetch = window.fetch.bind(window);
const downloads = new AbortController();
const loaded = new Map();
const debug = new URLSearchParams(location.search).has("debug");
let phase = "loading";
let engine;
let storage;
let assets;
let refreshPending = false;
let readyReject;
let startupTimer;
let repaintTime = 0;

function log(...parts) {
  const text = parts.map(value => value instanceof Error ? value.stack || value.message : String(value)).join(" ");
  if (debug) console.debug(text);
}

function saveDownload(name, text) {
  const url = URL.createObjectURL(new Blob([text], {type: "application/json"}));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function hasSaves() {
  try { return Boolean(engine?.FS?.analyzePath(saveRoot).exists); }
  catch { return false; }
}

function backup() {
  try { saveDownload("bb97-saves.json", (storage ? storage.export() : exportBackup(engine.FS))); }
  catch (error) { log(error); document.querySelector("#message").textContent = error.message; }
}

function fail(reason) {
  if (phase === "failed") return;
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log(error);
  phase = "failed";
  clearTimeout(startupTimer);
  downloads.abort(error);
  readyReject?.(error);
  loading.hidden = true;
  document.querySelector("#message").textContent = error.message;
  document.querySelector("#error").hidden = false;
  }

function updateProgress(path, bytes) {
  loaded.set(path, bytes);
  if (refreshPending || phase !== "loading") return;
  refreshPending = true;
  setTimeout(() => {
    refreshPending = false;
    if (!assets || phase !== "loading") return;
    const total = [...loaded.values()].reduce((sum, count) => sum + count, 0);
    const percent = Math.min(100, total * 100 / assets.downloadBytes);
    progress.value = percent;
    amount.textContent = `${Math.floor(percent)}% · ${(total / 1048576).toFixed(1)} / ${(assets.downloadBytes / 1048576).toFixed(1)} mib`;
    repaintTime = performance.now();
  }, Math.max(0, 100 - (performance.now() - repaintTime)));
}

async function getAsset(file) {
  return download(file, assetPartUrls(file, base), {
    fetcher: networkFetch,
    signal: downloads.signal,
    progress: bytes => updateProgress(file.path, bytes)
  });
}

function installEngine() {
  return new Promise((resolve, reject) => {
    readyReject = reject;
    const wasm = assets.files.find(file => file.path === "runtime/scummvm.wasm");
    const script = assets.files.find(file => file.path === "runtime/scummvm.js");
    window.Module = {
      canvas,
      noInitialRun: true,
      async bb97InitializeSettings(path) {
        const fs = window.Module.FS;
        fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        fs.mkdirTree(path.slice(0, path.lastIndexOf("/")) + "/extras");
        if (!fs.analyzePath(path).exists) fs.writeFile(path, gameConfig());
      },
      locateFile: name => engineFile(name, base),
      print: log,
      printErr: log,
      onAbort: reason => fail(new Error(`engine stopped: ${reason}`)),
      onExit: code => fail(new Error(code ? `engine exited with code ${code}` : "the game has closed. reload to play again.")),
      onRuntimeInitialized() {
        engine = window.Module;
        if (!engine.FS || !engine.callMain) {
          reject(new Error("the engine is missing its filesystem bridge"));
          return;
        }
        readyReject = null;
        resolve(engine);
      },
      instantiateWasm(imports, receive) {
        getAsset(wasm).then(bytes => WebAssembly.instantiate(bytes, imports)).then(result => receive(result.instance, result.module)).catch(error => { reject(error); fail(error); });
        return {};
      }
    };
    const element = document.createElement("script");
    element.src = assetUrl(script, base);
    element.integrity = `sha256-${encodeBytes(Uint8Array.from(script.sha256.match(/../g), byte => Number.parseInt(byte, 16)))}`;
    element.crossOrigin = "anonymous";
    element.onload = () => updateProgress(script.path, script.size);
    element.onerror = () => reject(new Error("the engine loader could not be loaded or failed its integrity check"));
    document.head.append(element);
  });
}

function installDataIndexes() {
  const root = {"gui-icons": {}, plugins: {}};
  for (const file of assets.files) {
    if (!file.path.startsWith("data/")) continue;
    const parts = file.path.slice(5).split("/");
    if (parts.length === 1) root[parts[0]] = file.size;
    else if (parts[0] === "plugins" && parts.length === 2) root.plugins[parts[1]] = file.size;
  }
  engine.FS.mkdirTree("/data/plugins");
  engine.FS.mkdirTree("/data/gui-icons");
  engine.FS.writeFile("/data/index.json", JSON.stringify(root));
  engine.FS.writeFile("/data/plugins/index.json", JSON.stringify(root.plugins));
  engine.FS.writeFile("/data/gui-icons/index.json", "{}");
}

function routeEngineFiles() {
  window.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base);
    const localPath = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : url.pathname.replace(/^\//, "");
    if (url.origin === base.origin && localPath.startsWith("data/")) {
      const fsPath = `/${localPath}`;
      if (engine.FS.analyzePath(fsPath).exists && !engine.FS.isDir(engine.FS.stat(fsPath).mode)) {
        const node = engine.FS.lookupPath(fsPath).node;
        const bytes = node.contents instanceof Uint8Array ? node.contents.subarray(0, node.usedBytes) : engine.FS.readFile(fsPath);
        return Promise.resolve(new Response(bytes, {headers: {"Content-Length": String(bytes.length), "Content-Type": localPath.endsWith(".json") ? "application/json" : "application/octet-stream"}}));
      }
      return networkFetch(new URL(localPath, base), options);
    }
    if (url.origin === base.origin && localPath === "scummvm.ini") return Promise.resolve(new Response(gameConfig(), {headers: {"Content-Type": "text/plain"}}));
    return networkFetch(input, options);
  };
}

function resumeAudio() {
  const contexts = new Set([engine?.SDL3?.audioContext, engine?.SDL2?.audioContext, engine?.SDL?.audioContext]);
  for (const context of contexts) {
    if (context?.state === "suspended" || context?.state === "interrupted") context.resume().catch(log);
  }
}

async function restoreOnRequest() {
  if (!new URLSearchParams(location.search).has("restore")) return;
  status.textContent = "choose a save backup";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.setAttribute("aria-label", "save backup");
  document.querySelector(".loading-content").append(input);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  document.querySelector(".loading-content").append(cancel);
  const file = await new Promise(resolve => {
    input.addEventListener("change", () => resolve(input.files[0]), {once: true});
    input.addEventListener("cancel", () => resolve(null), {once: true});
    cancel.addEventListener("click", () => resolve(null), {once: true});
  });
  if (file) {
    if (file.size > 24 * 1024 * 1024) throw new Error("choose a valid save backup under 24 mib");
    await restoreBackupBeforeStart(engine, await file.text());
  }
  input.remove();
  cancel.remove();
  history.replaceState(null, "", base.pathname);
  status.textContent = "loading";
}

async function boot() {
  try {
    if (location.protocol === "file:") throw new Error("serve the dist folder over https or localhost, not by opening index.html directly");
    if (!globalThis.WebAssembly || !globalThis.crypto?.subtle) throw new Error("this player needs webassembly, browser storage, and a secure connection. use https or localhost in a current browser.");
    log(release, navigator.userAgent);
    const response = await networkFetch(new URL("assets/manifest.json", base), {cache: "no-store", signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`asset manifest returned ${response.status}`);
    const text = await response.text();
    if (text.length > 65536) throw new Error("asset manifest is too large");
    assets = validateAssets(JSON.parse(text));
    if (assets.files.some(file => file.transport?.encoding === "gzip") && !globalThis.DecompressionStream) throw new Error("update your browser to load compressed game files");
    startupTimer = setTimeout(() => fail(new Error("engine initialization timed out. reload the page.")), 240000);
    await installEngine();
    clearTimeout(startupTimer);
    if (phase !== "loading") return;
    startupTimer = setTimeout(() => fail(new Error("save storage did not respond. close other game tabs, then reload.")), 45000);
    storage = await initializeSaves(engine, {base, fetcher: networkFetch, onError: log, onWarning: log});
    engine.bb97Saves = storage;
    log("save storage", storage.kind);
    navigator.storage?.persist?.().catch(log);
    clearTimeout(startupTimer);
    if (phase !== "loading") return;
    await restoreOnRequest();
    for (const path of ["/game", configRoot, "/data/plugins", "/data/gui-icons"]) engine.FS.mkdirTree(path);
    const files = assets.files.filter(file => !file.path.startsWith("runtime/"));
    await mapLimit(files, 2, async file => {
      const bytes = await getAsset(file);
      if (file.path === "game/baseball.he1") log(repairSteamScript(bytes, file.sha256));
      const path = `/${file.path}`;
      engine.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      engine.FS.writeFile(path, bytes, {canOwn: true});
      if (file.path.startsWith("data/") && !file.path.endsWith(".json") && !file.path.endsWith(".so")) {
        const cached = `/.cache/${file.path}`;
        engine.FS.mkdirTree(cached.slice(0, cached.lastIndexOf("/")));
        engine.FS.writeFile(cached, bytes, {canOwn: true});
      }
    });
    if (phase !== "loading") return;
    engine.FS.writeFile(`${configRoot}/scummvm.ini`, gameConfig());
    installDataIndexes();
    routeEngineFiles();
    if (!acknowledgePatchedEdition(engine, log)) log("startup notice requires manual acknowledgment with this engine");
    status.textContent = "starting";
    progress.value = 100;
    amount.textContent = "100%";
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (phase !== "loading") return;
    phase = "running";
    loading.hidden = true;
    canvas.focus({preventScroll: true});
    log("launch", ...engineArguments());
    engine.callMain(engineArguments());
  } catch (error) { fail(error); }
}

function start() {
  if (!navigator.locks) { boot(); return; }
  navigator.locks.request(`bb97-saves-active:${saveKey(base)}`, {ifAvailable: true}, async lock => {
    if (!lock) { fail(new Error("the game is already open in another tab. close that tab and reload to protect your saves.")); return; }
    await boot();
    await new Promise(() => {});
  }).catch(fail);
}

canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("pointerdown", () => { canvas.focus({preventScroll: true}); resumeAudio(); });
canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); fail(new Error("the graphics context was lost. reload the page.")); });
window.addEventListener("keydown", event => {
  resumeAudio();
  if (event.key === "F5" && event.ctrlKey) event.preventDefault();
  if (event.key === "Enter" && event.altKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.fullscreenElement) document.exitFullscreen().catch(log);
    else document.documentElement.requestFullscreen?.().catch(log);
  }
  if (event.code === "KeyO" && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = new URL("?restore", base).href;
  }
  if (event.code === "KeyS" && (event.ctrlKey || event.metaKey) && event.shiftKey && hasSaves()) {
    event.preventDefault();
    event.stopImmediatePropagation();
    backup();
  }
}, true);
window.addEventListener("error", event => fail(event.error || new Error(event.message)));
window.addEventListener("unhandledrejection", event => { event.preventDefault(); fail(event.reason); });
window.addEventListener("beforeunload", event => {
  storage?.flush().catch(log);
  if (storage?.isBusy()) { event.preventDefault(); event.returnValue = ""; }
});
document.querySelector("#reload").addEventListener("click", () => location.reload());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) storage?.flush().catch(log);
  else resumeAudio();
});
window.addEventListener("pagehide", () => storage?.flush().catch(log));
window.addEventListener("online", () => storage?.flush().catch(log));
start();
