const { app, BrowserWindow, ipcMain, dialog, protocol, net, globalShortcut } = require("electron");
const path           = require("path");
const os             = require("os");
const fs             = require("fs-extra");
const crypto         = require("crypto");
const { execSync, exec } = require("child_process");
const nfs            = require("fs");
const { generateTiles: generateTilesJS } = require("./tile-generator");

// ----------------------------------------------------------------
// GDAL ツール検索ユーティリティ
// ----------------------------------------------------------------
function gdalCandidateDirs() {
  const home = os.homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    `${home}/miniconda3/bin`,
    `${home}/anaconda3/bin`,
    `${home}/opt/miniconda3/bin`,
    `${home}/mambaforge/bin`,
    `${home}/miniforge3/bin`,
    `${home}/micromamba/bin`,
    "/opt/miniconda3/bin",
    "/opt/mambaforge/bin",
    "/opt/miniforge3/bin",
    "/opt/homebrew/Caskroom/miniconda/base/bin",
  ];
}

function findExecutable(names) {
  for (const dir of gdalCandidateDirs()) {
    for (const name of names) {
      const p = path.join(dir, name);
      try { nfs.accessSync(p, nfs.constants.X_OK); console.log(`[geo-electron] found ${name}: ${p}`); return p; } catch {}
    }
  }
  // ログインシェルで which 検索
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const query = names.map(n => `which ${n} 2>/dev/null`).join(" || ");
      const found = execSync(`${shell} -l -c '${query}'`, { stdio: "pipe", timeout: 8000 })
        .toString().trim().split("\n")[0].trim();
      if (found && found.startsWith("/")) {
        nfs.accessSync(found, nfs.constants.X_OK);
        console.log(`[geo-electron] found via ${shell}: ${found}`);
        return found;
      }
    } catch {}
  }
  return null;
}

const findGdalTranslate = () => findExecutable(["gdal_translate"]);
const findGdal2Tiles    = () => findExecutable(["gdal2tiles", "gdal2tiles.py"]);
const findGdalInfo      = () => findExecutable(["gdalinfo"]);

// キャッシュ（アプリ起動中に何度も検索しないよう）
let _cachedCondaPy       = undefined; // undefined=未検索, null=見つからない
let _cachedCondaPyTiles  = undefined;

// conda の Python を探す（GDAL バイナリより信頼性が高い）
// ※ ログインシェルへのフォールバックは意図的に行わない
//   （Homebrew Python 3.14 は abseil 依存が壊れているため GDAL が動かない）
function findCondaPython() {
  if (_cachedCondaPy !== undefined) return _cachedCondaPy;
  const home = os.homedir();

  // conda のベースディレクトリ候補
  const condaBaseDirs = [
    `${home}/anaconda3`,
    `${home}/miniconda3`,
    `${home}/opt/miniconda3`,
    `${home}/mambaforge`,
    `${home}/miniforge3`,
    `${home}/micromamba`,
    "/opt/miniconda3",
    "/opt/mambaforge",
    "/opt/miniforge3",
    "/opt/homebrew/Caskroom/miniconda/base",
  ];

  // 試すべき Python パスを収集（ベース環境 + 全 envs サブディレクトリ）
  const pythonPaths = [];
  for (const baseDir of condaBaseDirs) {
    const basePy = path.join(baseDir, "bin", "python");
    if (nfs.existsSync(basePy)) pythonPaths.push(basePy);

    // envs/ 以下の各環境も試す
    const envsDir = path.join(baseDir, "envs");
    try {
      const envNames = nfs.readdirSync(envsDir);
      for (const envName of envNames) {
        const envPy = path.join(envsDir, envName, "bin", "python");
        if (nfs.existsSync(envPy)) pythonPaths.push(envPy);
      }
    } catch {}
  }

  if (pythonPaths.length === 0) {
    console.warn("[geo-electron] no conda python candidates found");
    return (_cachedCondaPy = null);
  }
  console.log(`[geo-electron] testing ${pythonPaths.length} python(s) for GDAL…`);

  // 各 Python で GDAL + gdal2tiles が使えるか確認（gdal2tiles 優先）
  for (const pyPath of pythonPaths) {
    try {
      execSync(
        `"${pyPath}" -c "from osgeo import gdal; import gdal2tiles"`,
        { stdio: "pipe", timeout: 4000 }
      );
      console.log(`[geo-electron] conda python with GDAL+gdal2tiles: ${pyPath}`);
      return (_cachedCondaPy = pyPath);
    } catch {}
  }
  // gdal2tiles なくても GDAL だけあれば COG 変換には使える
  for (const pyPath of pythonPaths) {
    try {
      execSync(`"${pyPath}" -c "from osgeo import gdal"`, { stdio: "pipe", timeout: 4000 });
      console.log(`[geo-electron] conda python with GDAL (no gdal2tiles): ${pyPath}`);
      return (_cachedCondaPy = pyPath);
    } catch {}
  }

  console.warn("[geo-electron] no conda python with GDAL found. checked:", pythonPaths);
  return (_cachedCondaPy = null);
}

// gdal2tiles が使える Python を返す（GDAL だけでは不可）
function findCondaPythonForTiles() {
  if (_cachedCondaPyTiles !== undefined) return _cachedCondaPyTiles;
  const home = os.homedir();
  const condaBaseDirs = [
    `${home}/anaconda3`,
    `${home}/miniconda3`,
    `${home}/opt/miniconda3`,
    `${home}/mambaforge`,
    `${home}/miniforge3`,
    `${home}/micromamba`,
    "/opt/miniconda3",
    "/opt/mambaforge",
    "/opt/miniforge3",
    "/opt/homebrew/Caskroom/miniconda/base",
  ];
  const pythonPaths = [];
  for (const baseDir of condaBaseDirs) {
    const basePy = path.join(baseDir, "bin", "python");
    if (nfs.existsSync(basePy)) pythonPaths.push(basePy);
    const envsDir = path.join(baseDir, "envs");
    try {
      for (const envName of nfs.readdirSync(envsDir)) {
        const envPy = path.join(envsDir, envName, "bin", "python");
        if (nfs.existsSync(envPy)) pythonPaths.push(envPy);
      }
    } catch {}
  }
  if (pythonPaths.length === 0) return (_cachedCondaPyTiles = null);
  console.log(`[geo-electron] testing ${pythonPaths.length} python(s) for gdal2tiles…`);
  for (const pyPath of pythonPaths) {
    try {
      execSync(
        `"${pyPath}" -c "from osgeo import gdal; import gdal2tiles"`,
        { stdio: "pipe", timeout: 4000 }
      );
      console.log(`[geo-electron] tiles python: ${pyPath}`);
      return (_cachedCondaPyTiles = pyPath);
    } catch {}
  }
  console.warn("[geo-electron] no python with gdal2tiles found. checked:", pythonPaths);
  return (_cachedCondaPyTiles = null);
}

// ----------------------------------------------------------------
// カスタムスキームを特権登録（app.whenReady() より前に必須）
// ----------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: "localfile", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  { scheme: "photo",     privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: "tile",      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// ユーザーが選択したファイルのみ配信する（セキュリティ）
const allowedFiles = new Map(); // fileId  -> absoluteFilePath
const photoFileMap = new Map(); // photoId -> absoluteFilePath
const tileDirMap   = new Map(); // tileId  -> tileDirectory

// 写真ビューアウィンドウ（1つを使い回す）
let photoViewerWin = null;

// ----------------------------------------------------------------
// app 準備完了 → プロトコル登録 → ウィンドウ作成
// ----------------------------------------------------------------
app.whenReady().then(() => {

  // localfile://<fileId>  →  ファイルをストリーム配信（Range リクエスト対応）
  protocol.handle("localfile", (request) => {
    const url      = new URL(request.url);
    const filePath = allowedFiles.get(url.hostname);
    if (!filePath) return new Response(null, { status: 403 });
    return net.fetch(`file://${filePath}`, { headers: request.headers });
  });

  // photo://<photoId>  →  写真ファイルを配信
  protocol.handle("photo", async (request) => {
    try {
      const filePath = photoFileMap.get(new URL(request.url).hostname);
      if (!filePath) return new Response(null, { status: 404 });
      return net.fetch(`file://${filePath}`);
    } catch {
      return new Response(null, { status: 500 });
    }
  });

  // tile://<tileId>/<z>/<x>/<y>.png  →  事前生成タイルを配信
  // gdal2tiles はデフォルト TMS 形式（y=0 が南）、Leaflet は XYZ 形式（y=0 が北）
  // → y 座標を変換して正しいファイルを返す
  const EMPTY_PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082", "hex"
  );
  const emptyPngResponse = () => new Response(EMPTY_PNG, { headers: { "content-type": "image/png" } });

  protocol.handle("tile", async (request) => {
    try {
      const url     = new URL(request.url);
      const tileDir = tileDirMap.get(url.hostname);
      if (!tileDir) return emptyPngResponse();

      // pathname = "/<z>/<x>/<y>.png"
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 3) return emptyPngResponse();
      const z    = parseInt(parts[0]);
      const x    = parseInt(parts[1]);
      const yXYZ = parseInt(parts[2]); // Leaflet XYZ (y=0 が北)
      const yTMS = (1 << z) - 1 - yXYZ; // TMS (y=0 が南) に変換

      const fullPath = path.join(tileDir, String(z), String(x), `${yTMS}.png`);
      const data     = await fs.readFile(fullPath); // net.fetch より高速
      return new Response(data, {
        headers: { "content-type": "image/png", "cache-control": "max-age=86400" },
      });
    } catch {
      return emptyPngResponse();
    }
  });

  createWindow();

  // DevTools トグル（Cmd+Option+I）
  globalShortcut.register("CommandOrControl+Option+I", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.toggleDevTools();
  });
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#0b0f1a",
    show: false,  // レンダリング完了まで非表示
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer/index.html"));
  // ページが完全に描画されてから表示（白/黒ちらつき防止）
  win.once("ready-to-show", () => win.show());
}

// ----------------------------------------------------------------
// レンダラーログをメインプロセスのコンソールに転送
// ----------------------------------------------------------------
ipcMain.on("renderer-log", (_event, { level, args }) => {
  const prefix = `[renderer/${level}]`;
  if (level === "error") console.error(prefix, ...args);
  else console.log(prefix, ...args);
});

// ----------------------------------------------------------------
// タイルディレクトリの z/x/y 構造から地理的 bounds を逆算（Python 不要）
// gdal2tiles はデフォルト TMS 形式（y=0 が南）で生成するため、
// XYZ 変換を考慮してタイル座標→緯度経度に変換する
// ----------------------------------------------------------------
function getTileBoundsFromDir(tileDirPath) {
  try {
    const zDirs = nfs.readdirSync(tileDirPath)
      .filter(d => /^\d+$/.test(d))
      .map(Number)
      .sort((a, b) => a - b);
    if (zDirs.length === 0) return null;

    // 最大ズームで計算（精度が高い）
    const z = zDirs[zDirs.length - 1];
    const zDir = path.join(tileDirPath, String(z));
    let xDirs;
    try { xDirs = nfs.readdirSync(zDir).filter(d => /^\d+$/.test(d)).map(Number); }
    catch { return null; }
    if (xDirs.length === 0) return null;

    const minX = Math.min(...xDirs);
    const maxX = Math.max(...xDirs);

    // TMS y の全タイルを収集
    let minYtms = Infinity, maxYtms = -Infinity;
    for (const x of xDirs) {
      try {
        const yFiles = nfs.readdirSync(path.join(zDir, String(x)))
          .filter(f => f.endsWith(".png"))
          .map(f => parseInt(f));
        if (yFiles.length > 0) {
          minYtms = Math.min(minYtms, ...yFiles);
          maxYtms = Math.max(maxYtms, ...yFiles);
        }
      } catch {}
    }
    if (!isFinite(minYtms)) return null;

    // TMS y → XYZ y 変換（y = 2^z - 1 - yTMS）
    const n      = 1 << z;
    const minYxyz = n - 1 - maxYtms;
    const maxYxyz = n - 1 - minYtms;

    const toLon = (tx)  => tx / n * 360 - 180;
    const toLat = (ty)  => Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / n))) * 180 / Math.PI;

    const bounds = {
      west:  toLon(minX),
      east:  toLon(maxX + 1),
      north: toLat(minYxyz),
      south: toLat(maxYxyz + 1),
    };
    console.log(`[geo-electron] tile-derived bounds z${z}: N${bounds.north.toFixed(4)} S${bounds.south.toFixed(4)} W${bounds.west.toFixed(4)} E${bounds.east.toFixed(4)}`);
    return bounds;
  } catch (e) {
    console.warn("[geo-electron] getTileBoundsFromDir failed:", e.message);
    return null;
  }
}

// タイルディレクトリから最大ズームレベルを読み取る
function getMaxZoomFromDir(tileDirPath) {
  try {
    const zDirs = nfs.readdirSync(tileDirPath)
      .filter(d => /^\d+$/.test(d))
      .map(Number);
    return zDirs.length > 0 ? Math.max(...zDirs) : 18;
  } catch { return 18; }
}

// georaster オブジェクトから WGS84 bounds を取得
function getBoundsFromGeoraster(gr) {
  try {
    const proj4mod = require("proj4");
    const epsg = gr.projection;
    if (!epsg || epsg === 4326) {
      return { west: gr.xmin, east: gr.xmax, south: gr.ymin, north: gr.ymax };
    }
    const inv = proj4mod(`EPSG:${epsg}`, "EPSG:4326");
    const corners = [
      inv.forward([gr.xmin, gr.ymin]),
      inv.forward([gr.xmax, gr.ymin]),
      inv.forward([gr.xmax, gr.ymax]),
      inv.forward([gr.xmin, gr.ymax]),
    ];
    return {
      west:  Math.min(...corners.map(c => c[0])),
      east:  Math.max(...corners.map(c => c[0])),
      south: Math.min(...corners.map(c => c[1])),
      north: Math.max(...corners.map(c => c[1])),
    };
  } catch (e) {
    console.warn("[geo-electron] getBoundsFromGeoraster failed:", e.message);
    return null;
  }
}

function parseGdalinfoJson(raw) {
  const info = JSON.parse(raw);
  const c    = info.wgs84Extent?.coordinates?.[0] ?? info.cornerCoordinates;
  if (!c) return null;
  if (Array.isArray(c)) {
    const lons = c.map(p => p[0]);
    const lats = c.map(p => p[1]);
    return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
  }
  const pts  = Object.values(c).filter(Array.isArray);
  const lons = pts.map(p => p[0]);
  const lats = pts.map(p => p[1]);
  return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
}

function getWgs84Bounds(filePath) {
  // ① conda Python の GDAL API 経由（バイナリより確実）
  const condaPy = findCondaPython();
  if (condaPy) {
    try {
      const tmpBounds = path.join(os.tmpdir(), `geo_bounds_${Date.now()}.py`);
      const pyLines = [
        `import sys, json`,
        `from osgeo import gdal, osr`,
        `ds = gdal.Open(sys.argv[1])`,
        `gt = ds.GetGeoTransform()`,
        `w, h = ds.RasterXSize, ds.RasterYSize`,
        `src = osr.SpatialReference()`,
        `src.ImportFromWkt(ds.GetProjection())`,
        `dst = osr.SpatialReference()`,
        `dst.SetWellKnownGeogCS("WGS84")`,
        `src.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)`,
        `dst.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)`,
        `t = osr.CoordinateTransformation(src, dst)`,
        `pts = [t.TransformPoint(gt[0]+gt[1]*x+gt[2]*y, gt[3]+gt[4]*x+gt[5]*y) for x,y in [(0,0),(w,0),(w,h),(0,h)]]`,
        `lons = [p[0] for p in pts]`,
        `lats = [p[1] for p in pts]`,
        `print(json.dumps({"west":min(lons),"east":max(lons),"south":min(lats),"north":max(lats)}))`,
      ].join("\n");
      nfs.writeFileSync(tmpBounds, pyLines, "utf-8");
      const raw    = execSync(`"${condaPy}" "${tmpBounds}" "${filePath}"`, { stdio: "pipe", timeout: 10000 }).toString().trim();
      nfs.unlinkSync(tmpBounds);
      const bounds = JSON.parse(raw);
      if (bounds && bounds.west != null) { console.log("[geo-electron] bounds via Python:", bounds); return bounds; }
    } catch (e) {
      console.warn("[geo-electron] Python bounds failed:", e.message);
    }
  }

  // ② gdalinfo バイナリ経由（フォールバック）
  const gdalinfoBin = findGdalInfo();
  if (!gdalinfoBin) return null;
  try {
    const raw = execSync(
      `/bin/zsh -l -c '"${gdalinfoBin}" -json "${filePath}" 2>/dev/null'`,
      { stdio: "pipe", timeout: 15000 }
    ).toString();
    return parseGdalinfoJson(raw);
  } catch (e) {
    console.warn("[geo-electron] gdalinfo failed:", e.message);
    return null;
  }
}

// ----------------------------------------------------------------
// GeoTIFF 読み込み
// 優先順位: タイル生成 → COG 変換 → 元ファイル(ArrayBuffer)
// ----------------------------------------------------------------
ipcMain.handle("load-geotiff", async (event) => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
  });
  if (res.canceled) return null;

  const filePath = res.filePaths[0];
  const fileName = path.basename(filePath);
  const stat0    = await fs.stat(filePath);
  console.log(`[geo-electron] GeoTIFF selected: ${fileName} (${(stat0.size / 1024 / 1024).toFixed(1)} MB)`);

  const send  = (msg) => { try { event.sender.send("geotiff-progress", { message: msg }); } catch {} };
  const base  = filePath.replace(/\.(tif|tiff)$/i, "");

  // ---- ① タイル生成（最速：事前生成→ネイティブ描画） ----
  const tileDirPath = `${base}_tiles`;
  const stampFile   = path.join(tileDirPath, ".complete");

  const TILE_VERSION = "v2-tms"; // TMS 形式 + zoom>=14 を示すバージョン

  if (await fs.pathExists(stampFile)) {
    const stampContent  = await fs.readFile(stampFile, "utf-8").catch(() => "");
    const cachedMaxZoom = getMaxZoomFromDir(tileDirPath);
    const isStale       = cachedMaxZoom < 14 || !stampContent.includes(TILE_VERSION);
    if (isStale) {
      console.log(`[geo-electron] stale cache (maxZoom=${cachedMaxZoom}, stamp="${stampContent.trim()}"), regenerating…`);
      await fs.remove(tileDirPath);
    } else {
      console.log(`[geo-electron] tile cache found: ${tileDirPath} (maxZoom=${cachedMaxZoom})`);
      send("タイルキャッシュを読み込み中…");
      const tileId  = crypto.randomUUID();
      const fileId  = crypto.randomUUID();
      tileDirMap.set(tileId, tileDirPath);
      allowedFiles.set(fileId, filePath);
      const bounds   = getTileBoundsFromDir(tileDirPath) ?? getWgs84Bounds(filePath);
      console.log(`[geo-electron] cached bounds: ${JSON.stringify(bounds)}, maxNativeZoom: ${cachedMaxZoom}`);
      return { mode: "tiles", tileId, fileId, fileName, fileSize: stat0.size, bounds, maxNativeZoom: cachedMaxZoom };
    }
  }

  // ---- ① タイル生成（純 JS 実装 / gdal2tiles は不要）----
  {
    send("GeoTIFF を解析中…");
    try {
      send("タイル生成中… (初回のみ、しばらくお待ちください)");
      await fs.ensureDir(tileDirPath);

      let genResult = null;
      const tileOk = await new Promise(async (resolve) => {
        try {
          // filePath (文字列) を渡す — tile-generator.js が内部で geotiff.fromFile を使う
          genResult = await generateTilesJS(filePath, tileDirPath, {
            blackThreshold: 10,
            onProgress: (pct) => send(`タイル生成中… ${pct}%`),
          });
          resolve(true);
        } catch (e) {
          console.error("[geo-electron] JS tile gen error:", e.message, e.stack);
          resolve(false);
        }
      });

      if (tileOk) {
        await fs.writeFile(stampFile, `${new Date().toISOString()} ${TILE_VERSION}`);
        console.log(`[geo-electron] tiles generated (JS): ${tileDirPath}`);
        const tileId = crypto.randomUUID();
        const fileId = crypto.randomUUID();
        tileDirMap.set(tileId, tileDirPath);
        allowedFiles.set(fileId, filePath);
        // bounds は tile-generator.js が返す（geotiff.js のメタデータから計算済み）
        const bounds        = genResult?.bounds ?? getTileBoundsFromDir(tileDirPath) ?? getWgs84Bounds(filePath);
        const maxNativeZoom = genResult?.maxZoom ?? 18;
        console.log(`[geo-electron] bounds: ${JSON.stringify(bounds)}, maxNativeZoom: ${maxNativeZoom}`);
        return { mode: "tiles", tileId, fileId, fileName, fileSize: stat0.size, bounds, maxNativeZoom };
      }

      // 失敗 → 中途半端なディレクトリを削除
      fs.remove(tileDirPath).catch(() => {});
      send("タイル生成失敗。直接読み込みに切り替えます…");
    } catch (e) {
      console.error("[geo-electron] tile gen setup error:", e.message);
      fs.remove(tileDirPath).catch(() => {});
      send("タイル生成エラー。直接読み込みに切り替えます…");
    }
  }

  // ---- ② COG 変換（タイル生成不可時のフォールバック） ----
  let finalPath = filePath;
  const cogPath = `${base}_cog.tif`;
  const gdalBin = findGdalTranslate();

  if (gdalBin) {
    if (await fs.pathExists(cogPath)) {
      console.log(`[geo-electron] COG already exists: ${cogPath}`);
      send("COG ファイルを再利用中…");
      finalPath = cogPath;
    } else {
      send("COG に変換中（初回のみ）…");
      // COG 変換: Python API 経由（バイナリは SIGABRT で落ちるため）
      const condaPy2 = findCondaPython();
      let shellCmd;
      if (condaPy2) {
        const tmpScript2 = path.join(os.tmpdir(), `geo_cog_${Date.now()}.py`);
        const cogLines = [
          `from osgeo import gdal`,
          `gdal.UseExceptions()`,
          `ds = gdal.Open(r"""${filePath}""")`,
          `gdal.Translate(r"""${cogPath}""", ds, format="COG", creationOptions=["COMPRESS=LZW","BIGTIFF=IF_SAFER"])`,
          `print("0...10...20...30...40...50...60...70...80...90...100 - done.")`,
        ].join("\n");
        nfs.writeFileSync(tmpScript2, cogLines, "utf-8");
        shellCmd = `"${condaPy2}" "${tmpScript2}" 2>&1`;
      } else {
        const innerCmd = [
          `"${gdalBin}"`, `"${filePath}"`, `"${cogPath}"`,
          "-of COG", "-co COMPRESS=LZW", "-co BIGTIFF=IF_SAFER",
        ].join(" ");
        shellCmd = `/bin/zsh -l -c '${innerCmd} 2>&1'`;
      }
      console.log(`[geo-electron] exec: ${shellCmd}`);

      const cogOk = await new Promise((resolve) => {
        const child = exec(shellCmd, { timeout: 5 * 60 * 1000 });
        child.stdout.on("data", (d) => {
          const m = d.toString().match(/(\d+)\.\.\./);
          if (m) send(`COG 変換中… ${m[1]}%`);
        });
        child.on("close", (code) => {
          if (code === 0) { console.log(`[geo-electron] COG created: ${cogPath}`); resolve(true); }
          else { console.warn(`[geo-electron] gdal_translate exit ${code}`); fs.remove(cogPath).catch(() => {}); resolve(false); }
        });
        child.on("error", (e) => { fs.remove(cogPath).catch(() => {}); resolve(false); });
      });

      if (cogOk) finalPath = cogPath;
      else send("COG 変換失敗。元ファイルを使用します…");
    }
  } else {
    send("GDAL なし。元ファイルを読み込み中…");
  }

  const fileId = crypto.randomUUID();
  allowedFiles.set(fileId, finalPath);
  const stat   = await fs.stat(finalPath);
  console.log(`[geo-electron] serving: ${path.basename(finalPath)} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return { mode: finalPath !== filePath ? "cog" : "georaster", fileId, fileName: path.basename(finalPath), fileSize: stat.size };
});

// ----------------------------------------------------------------
// 写真フォルダ読み込み
// ----------------------------------------------------------------
ipcMain.handle("load-photos", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    message: "写真フォルダを選択してください",
  });
  if (res.canceled) return null;

  const dir   = res.filePaths[0];
  const files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|jpg)$/i.test(f));
  console.log(`[geo-electron] scanning ${files.length} JPEG files in ${dir}`);

  const exifr   = require("exifr");
  const results = [];

  for (const f of files) {
    const fullPath = path.join(dir, f);
    try {
      const gps = await exifr.gps(fullPath);
      if (gps && gps.latitude != null && gps.longitude != null) {
        const id = crypto.randomUUID();
        photoFileMap.set(id, fullPath);
        results.push({ id, lat: gps.latitude, lon: gps.longitude, filename: f });
      }
    } catch (e) {
      console.warn(`[geo-electron] skip ${f}: ${e.message}`);
    }
  }

  console.log(`[geo-electron] ${results.length} photos with GPS`);
  return results;
});

// ----------------------------------------------------------------
// 写真ビューアウィンドウを開く（または既存ウィンドウに写真を送る）
// ----------------------------------------------------------------
ipcMain.handle("open-photo-window", async (_event, { photoId, filename, focus = true }) => {
  if (!photoViewerWin || photoViewerWin.isDestroyed()) {
    photoViewerWin = new BrowserWindow({
      width: 720,
      height: 560,
      title: filename,
      backgroundColor: "#0b0f1a",
      webPreferences: {
        preload: path.join(__dirname, "preload-photo.js"),
        contextIsolation: true,
      },
    });
    await new Promise((resolve) => {
      photoViewerWin.webContents.once("did-finish-load", resolve);
      photoViewerWin.loadFile(path.join(__dirname, "renderer/photo-viewer.html"));
    });
    photoViewerWin.on("closed", () => { photoViewerWin = null; });
    // 新規作成時は必ず表示
    photoViewerWin.show();
  }

  photoViewerWin.webContents.send("show-photo", { photoId, filename });
  photoViewerWin.setTitle(filename);
  if (focus) {
    photoViewerWin.show();
    photoViewerWin.focus();
  }
});

// ----------------------------------------------------------------
// GeoJSON 保存
// ----------------------------------------------------------------
ipcMain.handle("save-vector", async (_event, { text, defaultName }) => {
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName || "edit.geojson",
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });
  if (res.canceled) return false;
  await fs.writeFile(res.filePath, text, "utf-8");
  console.log(`[geo-electron] saved vector: ${res.filePath}`);
  return true;
});

// ----------------------------------------------------------------
// GeoJSON / KML 読み込み
// ----------------------------------------------------------------
ipcMain.handle("load-vector", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Vector files", extensions: ["geojson", "json", "kml"] },
    ],
  });
  if (res.canceled) return null;

  const results = [];
  for (const filePath of res.filePaths) {
    const text     = await fs.readFile(filePath, "utf-8");
    const filename = path.basename(filePath);
    const ext      = path.extname(filePath).toLowerCase().slice(1);
    results.push({ text, filename, ext });
  }
  return results;
});
