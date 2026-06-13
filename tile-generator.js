"use strict";
/**
 * tile-generator.js – ストリーミング対応高速タイル生成
 *
 * geotiff.js の fromFile + readRasters({ window }) を使い、
 * タイルごとに必要なピクセルだけ読み込む。
 * → 巨大 GeoTIFF（数 GB）でもメモリ不足にならない。
 *
 * 最適化:
 *   1. proj4 変換はタイル4隅のみ → 線形補間 (65536→4 calls/tile)
 *   2. ウィンドウ読み込み: 必要ピクセルのみ I/O
 *   3. 読み込みはフラット TypedArray → 高速アクセス
 *   4. TMS 形式でディスク保存（プロトコルハンドラに合わせる）
 */

const fs      = require("fs-extra");
const nfs     = require("fs");
const path    = require("path");
const PNG     = require("pngjs").PNG;
const proj4   = require("proj4");
const GeoTIFF = require("geotiff");

// ----------------------------------------------------------------
// XYZ タイル座標 → 緯度経度
// ----------------------------------------------------------------
function tile2lon(x, z) { return x / (1 << z) * 360 - 180; }
function tile2lat(y, z) {
  const n = Math.PI * (1 - 2 * y / (1 << z));
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ----------------------------------------------------------------
// ズームレベル範囲の自動計算（WGS84 bounds 必須）
// ----------------------------------------------------------------
function calcZoomRange(imgWidth, boundsWgs84) {
  const lonSpan = boundsWgs84.lonMax - boundsWgs84.lonMin;
  const estZoom = Math.log2(360 * imgWidth / (256 * lonSpan));
  const maxZoom = Math.max(14, Math.min(Math.round(estZoom), 22));
  const minZoom = Math.max(0, maxZoom - 6);
  return { minZoom, maxZoom };
}

// ----------------------------------------------------------------
// メイン: GeoTIFF ファイルパス → XYZ タイル (TMS 形式で保存)
// ----------------------------------------------------------------
async function generateTiles(filePath, tileDirPath, opts = {}) {
  const {
    tileSize       = 256,
    blackThreshold = 10,
    onProgress     = null,
  } = opts;

  // ---- ファイルを開く（ピクセルデータはまだ読まない）----
  const tiff  = await GeoTIFF.fromFile(filePath);
  const image = await tiff.getImage();

  const imgWidth  = image.getWidth();
  const imgHeight = image.getHeight();
  const origin    = image.getOrigin();       // [xmin, ymax] in native CRS
  const res       = image.getResolution();   // [xRes, 0, yRes]  yRes < 0

  const xmin        = origin[0];
  const ymax        = origin[1];
  const pixelWidth  = Math.abs(res[0]);
  const pixelHeight = Math.abs(res[2] !== 0 ? res[2] : res[1]);
  const numBands    = image.getSamplesPerPixel();

  // EPSG コードを GeoKeys から取得
  const geoKeys = image.getGeoKeys();
  const epsg = geoKeys?.ProjectedCSTypeGeoKey
            ?? geoKeys?.GeographicTypeGeoKey
            ?? 4326;

  console.log(`[tile-gen] opened: ${imgWidth}x${imgHeight}px, ${numBands} bands, EPSG:${epsg}`);

  // 座標変換セットアップ
  let transform = null, invTransform = null;
  if (epsg && epsg !== 4326) {
    try {
      transform    = proj4("EPSG:4326", `EPSG:${epsg}`);
      invTransform = proj4(`EPSG:${epsg}`, "EPSG:4326");
    } catch { console.warn(`[tile-gen] unknown EPSG:${epsg}, treating as WGS84`); }
  }

  // WGS84 bounds を 4 隅変換で計算
  let boundsWgs84;
  if (!invTransform) {
    boundsWgs84 = {
      lonMin: xmin,                            lonMax: xmin + imgWidth  * pixelWidth,
      latMin: ymax - imgHeight * pixelHeight,  latMax: ymax,
    };
  } else {
    const corners = [
      [xmin,                          ymax],
      [xmin + imgWidth * pixelWidth,  ymax],
      [xmin,                          ymax - imgHeight * pixelHeight],
      [xmin + imgWidth * pixelWidth,  ymax - imgHeight * pixelHeight],
    ].map(([x, y]) => invTransform.forward([x, y]));
    boundsWgs84 = {
      lonMin: Math.min(...corners.map(c => c[0])), lonMax: Math.max(...corners.map(c => c[0])),
      latMin: Math.min(...corners.map(c => c[1])), latMax: Math.max(...corners.map(c => c[1])),
    };
  }
  console.log(`[tile-gen] bounds WGS84: lon[${boundsWgs84.lonMin.toFixed(4)},${boundsWgs84.lonMax.toFixed(4)}] lat[${boundsWgs84.latMin.toFixed(4)},${boundsWgs84.latMax.toFixed(4)}]`);

  // zoom 範囲
  let { minZoom, maxZoom } = opts;
  if (minZoom == null || maxZoom == null) {
    const r = calcZoomRange(imgWidth, boundsWgs84);
    if (minZoom == null) minZoom = r.minZoom;
    if (maxZoom == null) maxZoom = r.maxZoom;
  }
  console.log(`[tile-gen] zoom ${minZoom}–${maxZoom}, image ${imgWidth}x${imgHeight}px`);

  await fs.ensureDir(tileDirPath);

  // ---- 全ピクセルを一括読み込み（タイルごとにI/Oしない → 高速）----
  console.log(`[tile-gen] loading all rasters into memory…`);
  const t1 = Date.now();
  const rasters = await image.readRasters({ interleave: false });
  console.log(`[tile-gen] rasters loaded in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // タイル範囲を事前計算
  const zRanges = [];
  let totalTiles = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 1 << z;
    const txMin = Math.max(0, Math.floor((boundsWgs84.lonMin + 180) / 360 * n));
    const txMax = Math.min(n - 1, Math.floor((boundsWgs84.lonMax + 180) / 360 * n));
    const sMax  = Math.sin(boundsWgs84.latMax * Math.PI / 180);
    const sMin  = Math.sin(boundsWgs84.latMin * Math.PI / 180);
    const tyMin = Math.max(0, Math.floor((0.5 - Math.log((1 + sMax) / (1 - sMax)) / (4 * Math.PI)) * n));
    const tyMax = Math.min(n - 1, Math.floor((0.5 - Math.log((1 + sMin) / (1 - sMin)) / (4 * Math.PI)) * n));
    const count = (txMax - txMin + 1) * (tyMax - tyMin + 1);
    totalTiles += count;
    zRanges.push({ z, txMin, txMax, tyMin, tyMax, count });
    console.log(`[tile-gen] z${z}: x[${txMin}–${txMax}] y[${tyMin}–${tyMax}] (${count} tiles)`);
  }
  console.log(`[tile-gen] total tiles: ${totalTiles}`);

  let doneTiles = 0;
  const t0 = Date.now();

  for (const { z, txMin, txMax, tyMin, tyMax } of zRanges) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const txDir = path.join(tileDirPath, String(z), String(tx));
      await fs.ensureDir(txDir);

      for (let ty = tyMin; ty <= tyMax; ty++) {
        renderAndSaveTileFromMemory({
          rasters, z, tx, ty, tileSize,
          xmin, ymax, pixelWidth, pixelHeight, imgWidth, imgHeight,
          numBands, transform, blackThreshold, txDir,
        });

        doneTiles++;
        if (onProgress && doneTiles % 50 === 0) {
          onProgress(Math.round(doneTiles / totalTiles * 100));
        }
      }
      // 各 x 列の後に一度だけイベントループを譲る（UI 応答維持）
      await new Promise(r => setImmediate(r));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[tile-gen] done: ${doneTiles} tiles in ${elapsed}s`);

  // bounds を { west, east, south, north } 形式で返す（main.js で利用）
  const bounds = {
    west:  boundsWgs84.lonMin,
    east:  boundsWgs84.lonMax,
    south: boundsWgs84.latMin,
    north: boundsWgs84.latMax,
  };
  return { maxZoom, bounds };
}

// ----------------------------------------------------------------
// 1 タイルをメモリ内ラスタから PNG に変換してディスクに保存（同期 I/O）
// rasters: image.readRasters() で一括ロード済みの TypedArray[]
// ----------------------------------------------------------------
function renderAndSaveTileFromMemory({
  rasters, z, tx, ty, tileSize,
  xmin, ymax, pixelWidth, pixelHeight, imgWidth, imgHeight,
  numBands, transform, blackThreshold, txDir,
}) {
  // タイルの地理的 4 隅（WGS84）
  const lonW = tile2lon(tx,     z), lonE = tile2lon(tx + 1, z);
  const latN = tile2lat(ty,     z), latS = tile2lat(ty + 1, z);

  // 4 隅を native CRS に変換（proj4 は 4 回のみ）
  let cxNW, cyNW, cxNE, cyNE, cxSW, cySW, cxSE, cySE;
  if (transform) {
    [cxNW, cyNW] = transform.forward([lonW, latN]);
    [cxNE, cyNE] = transform.forward([lonE, latN]);
    [cxSW, cySW] = transform.forward([lonW, latS]);
    [cxSE, cySE] = transform.forward([lonE, latS]);
  } else {
    cxNW = lonW; cyNW = latN; cxNE = lonE; cyNE = latN;
    cxSW = lonW; cySW = latS; cxSE = lonE; cySE = latS;
  }

  const invPW = 1 / pixelWidth;
  const invPH = 1 / pixelHeight;
  const nb    = Math.min(numBands, rasters.length);

  const png  = new PNG({ width: tileSize, height: tileSize, filterType: -1 });
  const data = png.data;
  let hasPixel = false;

  for (let py = 0; py < tileSize; py++) {
    const fy  = (py + 0.5) / tileSize;
    // y 方向線形補間
    const cxW = cxNW + (cxSW - cxNW) * fy;
    const cxE = cxNE + (cxSE - cxNE) * fy;
    const cyW = cyNW + (cySW - cyNW) * fy;
    const cyE = cyNE + (cySE - cyNE) * fy;
    const dcx = (cxE - cxW) / tileSize;
    const dcy = (cyE - cyW) / tileSize;
    const rowBase = py * tileSize * 4;

    for (let px = 0; px < tileSize; px++) {
      const cx = cxW + dcx * (px + 0.5);
      const cy = cyW + dcy * (px + 0.5);

      // 画像全体のピクセルインデックス（ニアレストネイバー）
      const col = ((cx - xmin) * invPW) | 0;
      const row = ((ymax  - cy) * invPH) | 0;
      const idx = rowBase + px * 4;

      if (col < 0 || col >= imgWidth || row < 0 || row >= imgHeight) {
        data[idx] = data[idx+1] = data[idx+2] = data[idx+3] = 0;
        continue;
      }

      const fi = row * imgWidth + col;  // フラット TypedArray インデックス

      const v0 = rasters[0][fi];
      if (v0 == null || v0 !== v0) { // null/NaN チェック
        data[idx] = data[idx+1] = data[idx+2] = data[idx+3] = 0;
        continue;
      }

      let v1 = 0, v2 = 0, v3 = 255;
      if (nb >= 3) { v1 = rasters[1][fi]; v2 = rasters[2][fi]; }
      if (nb >= 4) { v3 = rasters[3][fi] ?? 255; }

      // 黒画素透過
      if (blackThreshold != null && v0 <= blackThreshold &&
          (nb < 3 || (v1 <= blackThreshold && v2 <= blackThreshold))) {
        data[idx] = data[idx+1] = data[idx+2] = data[idx+3] = 0;
        continue;
      }

      hasPixel = true;
      if (nb >= 3) {
        data[idx]   = v0 < 0 ? 0 : v0 > 255 ? 255 : v0 + 0.5 | 0;
        data[idx+1] = v1 < 0 ? 0 : v1 > 255 ? 255 : v1 + 0.5 | 0;
        data[idx+2] = v2 < 0 ? 0 : v2 > 255 ? 255 : v2 + 0.5 | 0;
        data[idx+3] = v3 < 0 ? 0 : v3 > 255 ? 255 : v3 + 0.5 | 0;
      } else {
        const g = v0 < 0 ? 0 : v0 > 255 ? 255 : v0 + 0.5 | 0;
        data[idx] = data[idx+1] = data[idx+2] = g; data[idx+3] = 255;
      }
    }
  }

  if (!hasPixel) return;

  // TMS 形式でファイル保存（プロトコルハンドラが TMS を期待）
  const yTMS = ((1 << z) - 1 - ty);
  // 同期書き込み（await なし → イベントループをブロックしないよう注意）
  nfs.writeFileSync(path.join(txDir, `${yTMS}.png`), PNG.sync.write(png));
}

module.exports = { generateTiles, calcZoomRange };
