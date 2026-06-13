// ----------------------------------------------------------------
// 設定
// ----------------------------------------------------------------
const settings = {
  transparentBlack: true,
  blackThreshold: 10,   // この値以下のピクセルを透過（0〜255）
  markerRadius: 6,      // 写真マーカーの半径（px）
  vectorMarkerRadius: 7, // Vector マーカーの半径（px）
};

// ----------------------------------------------------------------
// ベースマップ定義
// ----------------------------------------------------------------
const baseLayers = {
  "Dark": L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/">CARTO</a>', subdomains: "abcd", maxZoom: 23 }
  ),
  "Street": L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/">CARTO</a>', subdomains: "abcd", maxZoom: 23 }
  ),
  "Aerial": L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tiles &copy; Esri", maxZoom: 23, maxNativeZoom: 18 }
  ),
};

// ----------------------------------------------------------------
// Leaflet マップ初期化
// ----------------------------------------------------------------
const map = L.map("map", {
  crs: L.CRS.EPSG3857,
  center: [35.68, 139.69],
  zoom: 5,
  maxZoom: 23,
  zoomControl: false,
  layers: [baseLayers["Aerial"]],
});

// GeoRasterLayer 専用 pane（z-index 350）
// ベースレイヤーを切り替えても常に上に表示される
map.createPane("rasterPane");
map.getPane("rasterPane").style.zIndex = 350;
map.getPane("rasterPane").style.pointerEvents = "none";

L.control.zoom({ position: "bottomleft" }).addTo(map);
L.control.layers(baseLayers, {}, { position: "topright", collapsed: false }).addTo(map);

// Electron では BrowserWindow の描画が落ち着く前に Leaflet が初期化されることがある。
// invalidateSize() でタイルを再計算して確実に表示させる。
setTimeout(() => map.invalidateSize(), 100);
window.addEventListener("resize", () => map.invalidateSize());

let tiffLayer        = null;
let currentGeoraster = null; // 設定変更時に再レンダリングするために保持

// レイヤー表示状態
let tiffVisible    = true;
let tiffFileName   = "";
let photosVisible  = true;

// ----------------------------------------------------------------
// 進捗オーバーレイ
// ----------------------------------------------------------------
const overlay     = document.getElementById("progress-overlay");
const progressMsg = document.getElementById("progress-msg");
function showProgress(msg) { progressMsg.textContent = msg; overlay.classList.remove("hidden"); }
function hideProgress()    { overlay.classList.add("hidden"); }

// ----------------------------------------------------------------
// GeoRasterLayer の pixelValuesToColorFn を生成
// ----------------------------------------------------------------
function makeColorFn(noDataValue) {
  const { transparentBlack, blackThreshold } = settings;

  return (values) => {
    // nodata ピクセルは透明
    if (noDataValue != null && values.some((v) => v === noDataValue)) return null;

    // null / NaN バンドを除外
    const valid = values.filter((v) => v !== null && v !== undefined && !isNaN(v));
    if (valid.length === 0) return null;

    // 黒画素透過チェック
    if (transparentBlack && valid.every((v) => v <= blackThreshold)) return null;

    // 3バンド RGB / 4バンド RGBA
    if (values.length >= 3) {
      const [r, g, b] = values;
      const a = values[3] != null ? values[3] / 255 : 1;
      return `rgba(${r},${g},${b},${a})`;
    }

    // 1バンド グレースケール
    const v = values[0] ?? 0;
    return `rgba(${v},${v},${v},1)`;
  };
}

// ----------------------------------------------------------------
// GeoRasterLayer を作成・マップに追加（georaster モード用）
// ----------------------------------------------------------------
function applyGeoRasterLayer(georaster) {
  if (tiffLayer) { map.removeLayer(tiffLayer); tiffLayer = null; }
  tiffLayer = new GeoRasterLayer({
    georaster,
    pane: "rasterPane",
    opacity: 0.9,
    resolution: 512,
    maxZoom: 23,
    pixelValuesToColorFn: makeColorFn(georaster.noDataValue),
  });
  tiffLayer.addTo(map);
}

// 後方互換（設定変更時の再レンダリング用）
function applyTiffLayer(georaster) { applyGeoRasterLayer(georaster); }

// ----------------------------------------------------------------
// タイルレイヤーを作成・マップに追加（tiles モード用）
// maxNativeZoom: 実際にタイルファイルが存在する最大 zoom（これ以上は Leaflet がスケールアップ表示）
// ----------------------------------------------------------------
function applyTileLayer(tileId, maxNativeZoom = 18) {
  if (tiffLayer) { map.removeLayer(tiffLayer); tiffLayer = null; }
  tiffLayer = L.tileLayer(`tile://${tileId}/{z}/{x}/{y}.png`, {
    pane:          "rasterPane",
    opacity:       0.9,
    maxZoom:       23,
    maxNativeZoom: maxNativeZoom, // タイルが存在する最大ズーム（それ以上は拡大表示）
    tileSize:      256,
    keepBuffer:    4,
    // 存在しないタイル（画像範囲外）は透明にする
    errorTileUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  });
  tiffLayer.addTo(map);
}

// ----------------------------------------------------------------
// GeoTIFF 変換進捗リスナー（main プロセスから push される）
// ----------------------------------------------------------------
window.api.onGeotiffProgress(({ message }) => {
  showProgress(message);
});

// ----------------------------------------------------------------
// GeoTIFF 読み込みボタン
// ----------------------------------------------------------------
document.getElementById("load-tiff").onclick = async () => {
  showProgress("ファイルを選択中…");

  let result;
  try {
    result = await window.api.loadGeoTIFF();
  } catch (err) {
    hideProgress();
    alert(`ファイル選択に失敗しました:\n${err.message}`);
    return;
  }

  if (!result) { hideProgress(); return; }

  const { mode, fileId, tileId, fileSize, bounds, maxNativeZoom, fileName } = result;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
  tiffFileName  = fileName || result.fileName || "GeoTIFF";
  tiffVisible   = true;

  try {
    // ---- タイルモード（最速）----
    if (mode === "tiles") {
      showProgress("タイルを読み込み中…");
      applyTileLayer(tileId, maxNativeZoom ?? 18);
      window.api.rlog("info", `tile layer: tileId=${tileId}, maxNativeZoom=${maxNativeZoom}`);
      currentGeoraster = null; // タイルモードでは georaster を使わない

      // bounds を取得（main プロセスから受け取った値を優先）
      let lb = null;
      if (bounds) {
        lb = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
        if (!lb.isValid()) { window.api.rlog("warn", "bounds invalid:", JSON.stringify(bounds)); lb = null; }
      }
      if (!lb) {
        // フォールバック: parseGeoraster でヘッダのみ読んで bounds 取得
        try {
          const gr  = await parseGeoraster(`localfile://${fileId}`);
          const tmp = new GeoRasterLayer({ georaster: gr, resolution: 64 });
          lb = tmp.getBounds();
          if (!lb?.isValid()) lb = null;
          else window.api.rlog("info", "bounds from parseGeoraster:", tmp.getBounds().toBBoxString());
        } catch (e) {
          window.api.rlog("warn", "bounds fallback failed:", e.message);
        }
      }
      if (lb) {
        // moveend の二重登録を防ぐ（前回の fitBounds が途中の場合も考慮）
        map.off("moveend");
        map.fitBounds(lb, { padding: [20, 20] });
        map.once("moveend", () => map.setZoom(Math.min(map.getZoom() + 4, 23)));
        window.api.rlog("info", "fitBounds:", lb.toBBoxString());
      } else {
        window.api.rlog("warn", "bounds 取得失敗 - マップ位置は手動で確認してください");
      }
      updateLayersPanel();
      hideProgress();
      return;
    }

    // ---- COG / georaster モード（フォールバック）----
    const url = `localfile://${fileId}`;

    if (mode === "cog") {
      // COG: Range リクエストで必要なタイルだけ取得
      showProgress(`COG を解析中… (${sizeMB} MB)`);
      currentGeoraster = await parseGeoraster(url);
    } else {
      // 非 COG: ファイル全体を ArrayBuffer で読み込む
      showProgress(`GeoTIFF を読み込み中… (${sizeMB} MB)`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
      const buf = await resp.arrayBuffer();
      currentGeoraster = await parseGeoraster(buf);
    }

    showProgress("レンダリング中…");
    applyGeoRasterLayer(currentGeoraster);
    updateLayersPanel();

    const lb = tiffLayer.getBounds();
    if (lb && lb.isValid()) {
      map.off("moveend");
      map.fitBounds(lb, { padding: [20, 20] });
      map.once("moveend", () => map.setZoom(Math.min(map.getZoom() + 4, 23)));
    }
    hideProgress();
  } catch (err) {
    hideProgress();
    window.api.rlog("error", "GeoTIFF error:", err.message, err.stack);
    alert(`GeoTIFF の表示に失敗しました:\n\n${err.message}`);
  }
};

// ----------------------------------------------------------------
// ベクターレイヤー管理
// ----------------------------------------------------------------
const VECTOR_COLORS = ["#ff6b6b","#ffd93d","#6bcb77","#4d96ff","#ff922b","#cc5de8","#20c997","#f06595"];
let vectorColorIdx = 0;
const vectorLayers = []; // { id, filename, layer, color }

// ---- 編集モード状態 ----
let editingLayerId     = null;
let editSelectedMarker = null;
let _suppressMapClick  = false;

function enterEditMode(id) {
  exitEditMode();
  editingLayerId = id;
  map.getContainer().style.cursor = "crosshair";
  updateVectorPanel();
}

function exitEditMode() {
  if (editSelectedMarker) {
    const item = vectorLayers.find(v => v.id === editingLayerId);
    if (item) _resetMarkerStyle(editSelectedMarker, item.color);
    editSelectedMarker = null;
  }
  editingLayerId = null;
  map.getContainer().style.cursor = "";
  updateVectorPanel();
}

function _resetMarkerStyle(marker, color) {
  marker.setStyle({ fillColor: color, color: "#ffffff", weight: 1.5, fillOpacity: 0.8 });
  marker.setRadius(settings.vectorMarkerRadius);
}

function selectEditMarker(marker, item) {
  if (editSelectedMarker && editSelectedMarker !== marker) {
    _resetMarkerStyle(editSelectedMarker, item.color);
  }
  editSelectedMarker = marker;
  marker.setStyle({ fillColor: "#ff4444", color: "#ffffff", weight: 2.5, fillOpacity: 1 });
  marker.setRadius(9);
}

function deleteSelectedMarker() {
  if (!editSelectedMarker || !editingLayerId) return;
  const item = vectorLayers.find(v => v.id === editingLayerId);
  if (item) item.layer.removeLayer(editSelectedMarker);
  editSelectedMarker = null;
}

async function saveEditingLayer() {
  const item = vectorLayers.find(v => v.id === editingLayerId);
  if (!item) return;
  const geojson = item.layer.toGeoJSON();
  await window.api.saveVector(JSON.stringify(geojson, null, 2), item.filename);
}

// Delete / Backspace で選択マーカーを削除
document.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && editSelectedMarker) {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    e.preventDefault();
    deleteSelectedMarker();
  }
});

// KML テキスト → GeoJSON FeatureCollection（DOMParser は Chromium で利用可能）
function kmlToGeoJSON(text) {
  const dom      = new DOMParser().parseFromString(text, "text/xml");
  const features = [];

  function parseCoords(str) {
    return str.trim().split(/\s+/).map((c) => {
      const [lon, lat] = c.split(",").map(Number);
      return [lon, lat];
    }).filter(([lon, lat]) => !isNaN(lon) && !isNaN(lat));
  }

  for (const pm of dom.getElementsByTagName("Placemark")) {
    const name        = pm.getElementsByTagName("name")[0]?.textContent?.trim() || "";
    const description = pm.getElementsByTagName("description")[0]?.textContent?.trim() || "";
    const props       = { name, description };

    const point = pm.getElementsByTagName("Point")[0];
    if (point) {
      const raw = point.getElementsByTagName("coordinates")[0]?.textContent;
      if (raw) {
        const [lon, lat] = raw.trim().split(",").map(Number);
        features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
      }
    }

    const line = pm.getElementsByTagName("LineString")[0];
    if (line) {
      const raw = line.getElementsByTagName("coordinates")[0]?.textContent;
      if (raw) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: parseCoords(raw) }, properties: props });
    }

    const polygon = pm.getElementsByTagName("Polygon")[0];
    if (polygon) {
      const outer = polygon.getElementsByTagName("outerBoundaryIs")[0]?.getElementsByTagName("coordinates")[0]?.textContent;
      if (outer) {
        const rings = [parseCoords(outer)];
        for (const inner of polygon.getElementsByTagName("innerBoundaryIs")) {
          const raw2 = inner.getElementsByTagName("coordinates")[0]?.textContent;
          if (raw2) rings.push(parseCoords(raw2));
        }
        features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: rings }, properties: props });
      }
    }

    // MultiGeometry（再帰は省略、直下の子形状のみ対応）
    const multi = pm.getElementsByTagName("MultiGeometry")[0];
    if (multi) {
      for (const child of multi.children) {
        const raw = child.getElementsByTagName("coordinates")[0]?.textContent;
        if (!raw) continue;
        const tag = child.tagName;
        if (tag === "Point") {
          const [lon, lat] = raw.trim().split(",").map(Number);
          features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });
        } else if (tag === "LineString") {
          features.push({ type: "Feature", geometry: { type: "LineString", coordinates: parseCoords(raw) }, properties: props });
        }
      }
    }
  }

  return { type: "FeatureCollection", features };
}

// GeoJSON を Leaflet レイヤーに変換してマップに追加
function addVectorLayer(geojson, filename) {
  const color = VECTOR_COLORS[vectorColorIdx % VECTOR_COLORS.length];
  vectorColorIdx++;
  const id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();

  const layer = L.geoJSON(geojson, {
    style: {
      color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.25,
    },
    pointToLayer: (feature, latlng) =>
      L.circleMarker(latlng, {
        radius: settings.vectorMarkerRadius, fillColor: color, fillOpacity: 0.8, color: "#ffffff", weight: 1.5,
      }),
    onEachFeature: (feature, lyr) => {
      const name = feature.properties?.name || feature.properties?.Name || "";
      const desc = feature.properties?.description || "";
      if (name || desc) {
        lyr.bindPopup(
          `<strong>${name}</strong>${desc ? `<br><span style="font-size:12px">${desc}</span>` : ""}`,
          { maxWidth: 280 }
        );
      }
    },
  });

  // 編集モード時のマーカークリック（点のみ選択可能）
  layer.on("click", (e) => {
    if (editingLayerId !== id) return;
    if (!e.layer || !e.layer.getLatLng) return; // 点以外は無視
    _suppressMapClick = true;
    requestAnimationFrame(() => { _suppressMapClick = false; });
    const item = vectorLayers.find(v => v.id === id);
    if (item) selectEditMarker(e.layer, item);
  });

  layer.addTo(map);
  vectorLayers.push({ id, filename, layer, color, visible: true });
  updateLayersPanel();

  try {
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
  } catch {}
}

// ----------------------------------------------------------------
// 全レイヤーパネルを更新（GeoTIFF / 写真 / Vector）
// ----------------------------------------------------------------
function updateLayersPanel() {
  const panel = document.getElementById("vector-panel");
  const list  = document.getElementById("vector-list");
  list.innerHTML = "";

  const hasAny = tiffLayer || photoLayers.length > 0 || vectorLayers.length > 0;
  panel.classList.toggle("hidden", !hasAny);
  if (!hasAny) return;

  // ---- GeoTIFF 行 ----
  if (tiffLayer) {
    const row = makeLayerRow({
      icon: "🗺",
      label: tiffFileName,
      visible: tiffVisible,
      onToggle: (v) => {
        tiffVisible = v;
        if (v) tiffLayer.addTo(map); else map.removeLayer(tiffLayer);
      },
    });
    list.appendChild(row);
  }

  // ---- 写真 行 ----
  if (photoLayers.length > 0) {
    const row = makeLayerRow({
      icon: "📷",
      label: `写真 (${photoLayers.length}枚)`,
      visible: photosVisible,
      onToggle: (v) => {
        photosVisible = v;
        photoLayers.forEach(l => { if (v) l.addTo(map); else map.removeLayer(l); });
      },
    });
    list.appendChild(row);
  }

  // ---- Vector 行 ----
  for (const item of vectorLayers) {
    const isEditing = editingLayerId === item.id;
    const row = document.createElement("div");
    row.className = "vector-item" + (isEditing ? " vector-item--editing" : "");

    // 表示チェックボックス
    const cb = document.createElement("input");
    cb.type    = "checkbox";
    cb.checked = item.visible !== false;
    cb.className = "layer-checkbox";
    cb.onchange = () => {
      item.visible = cb.checked;
      if (cb.checked) item.layer.addTo(map); else map.removeLayer(item.layer);
    };

    // カラーピッカー
    const colorInput = document.createElement("input");
    colorInput.type      = "color";
    colorInput.value     = item.color;
    colorInput.className = "vector-color-input";
    colorInput.title     = "色を変更";
    colorInput.oninput   = () => {
      item.color = colorInput.value;
      item.layer.eachLayer((l) => {
        if (l.setStyle) l.setStyle({ fillColor: item.color, color: l.getLatLng ? "#ffffff" : item.color });
      });
      swatch.style.background = item.color;
    };

    const swatch = document.createElement("span");
    swatch.className      = "vector-swatch";
    swatch.style.background = item.color;
    swatch.title          = "色を変更";
    swatch.style.cursor   = "pointer";
    swatch.onclick        = () => colorInput.click();

    const label = document.createElement("span");
    label.className  = "vector-name";
    label.textContent = item.filename;

    if (isEditing) {
      const saveBtn = document.createElement("button");
      saveBtn.className = "vector-edit-btn vector-save-btn";
      saveBtn.textContent = "保存";
      saveBtn.onclick = () => saveEditingLayer();

      const doneBtn = document.createElement("button");
      doneBtn.className = "vector-edit-btn vector-done-btn";
      doneBtn.textContent = "終了";
      doneBtn.onclick = () => exitEditMode();

      row.append(cb, colorInput, swatch, label, saveBtn, doneBtn);
    } else {
      const editBtn = document.createElement("button");
      editBtn.className   = "vector-edit-btn";
      editBtn.textContent = "編集";
      editBtn.onclick     = () => enterEditMode(item.id);

      const removeBtn = document.createElement("button");
      removeBtn.className   = "vector-remove";
      removeBtn.textContent = "✕";
      removeBtn.onclick     = () => {
        if (editingLayerId === item.id) exitEditMode();
        map.removeLayer(item.layer);
        const idx = vectorLayers.findIndex((v) => v.id === item.id);
        if (idx !== -1) vectorLayers.splice(idx, 1);
        updateLayersPanel();
      };

      row.append(cb, colorInput, swatch, label, editBtn, removeBtn);
    }

    list.appendChild(row);
  }

  // 編集中ヒント
  if (editingLayerId) {
    const hint = document.createElement("div");
    hint.className  = "vector-edit-hint";
    hint.textContent = "クリック: 追加 ／ 点をクリック→Delete: 削除";
    list.appendChild(hint);
  }
}

// GeoTIFF / 写真 用のシンプルな行を生成
function makeLayerRow({ icon, label, visible, onToggle }) {
  const row = document.createElement("div");
  row.className = "vector-item";

  const cb = document.createElement("input");
  cb.type      = "checkbox";
  cb.checked   = visible;
  cb.className = "layer-checkbox";
  cb.onchange  = () => onToggle(cb.checked);

  const iconSpan = document.createElement("span");
  iconSpan.textContent = icon;
  iconSpan.style.fontSize = "12px";

  const nameSpan = document.createElement("span");
  nameSpan.className   = "vector-name";
  nameSpan.textContent = label;

  row.append(cb, iconSpan, nameSpan);
  return row;
}

// 旧名エイリアス（enterEditMode / exitEditMode から呼ぶ）
function updateVectorPanel() { updateLayersPanel(); }

// Vector ボタン
document.getElementById("load-vector").onclick = async () => {
  showProgress("ファイルを選択中…");

  let files;
  try {
    files = await window.api.loadVector();
  } catch (err) {
    hideProgress();
    alert(`Vector ファイルの読み込みに失敗しました:\n${err.message}`);
    return;
  }

  if (!files || files.length === 0) { hideProgress(); return; }

  for (const { text, filename, ext } of files) {
    try {
      let geojson;
      if (ext === "kml") {
        geojson = kmlToGeoJSON(text);
      } else {
        geojson = JSON.parse(text);
      }
      addVectorLayer(geojson, filename);
    } catch (err) {
      alert(`${filename} の解析に失敗しました:\n${err.message}`);
    }
  }

  hideProgress();
};

// ----------------------------------------------------------------
// 写真フォルダ読み込みボタン
// ----------------------------------------------------------------
const photoLayers = [];
const photoData   = [];  // { lat, lon, id, filename }
let selectedPhotoIndex = -1;

const MARKER_DEFAULT  = { fillColor: "#58a6ff", color: "#ffffff", weight: 2,   fillOpacity: 0.85 };
const MARKER_SELECTED = { fillColor: "#ff9500", color: "#ffffff", weight: 2.5, fillOpacity: 1.0  };

function selectPhoto(index, { openWindow = false, fromKeyboard = false } = {}) {
  if (photoLayers.length === 0) return;
  const n = photoLayers.length;
  index = ((index % n) + n) % n;  // 折り返し

  // 前の選択マーカーをリセット（スタイル + ツールチップを閉じる）
  if (selectedPhotoIndex >= 0 && selectedPhotoIndex < photoLayers.length) {
    photoLayers[selectedPhotoIndex].setStyle(MARKER_DEFAULT);
    photoLayers[selectedPhotoIndex].closeTooltip();
  }

  selectedPhotoIndex = index;
  photoLayers[index].setStyle(MARKER_SELECTED);
  map.panTo([photoData[index].lat, photoData[index].lon]);

  // 写真ウィンドウを開く or 更新（矢印キー時はフォーカスを奪わない）
  if (openWindow) openPhotoWindow(photoData[index], { focus: !fromKeyboard });
}

// 矢印キーで選択マーカーを移動（写真ウィンドウも連動）
document.addEventListener("keydown", (e) => {
  if (photoLayers.length === 0) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    selectPhoto(selectedPhotoIndex < 0 ? 0 : selectedPhotoIndex + 1, { openWindow: true, fromKeyboard: true });
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    selectPhoto(selectedPhotoIndex <= 0 ? photoLayers.length - 1 : selectedPhotoIndex - 1, { openWindow: true, fromKeyboard: true });
  }
});

document.getElementById("load-photos").onclick = async () => {
  showProgress("写真フォルダを読み込み中…");

  let photos;
  try {
    photos = await window.api.loadPhotos();
  } catch (err) {
    hideProgress();
    alert(`写真の読み込みに失敗しました:\n${err.message}`);
    return;
  }

  if (!photos) { hideProgress(); return; }

  photoLayers.forEach((l) => map.removeLayer(l));
  photoLayers.length = 0;
  photoData.length   = 0;
  selectedPhotoIndex = -1;
  photosVisible      = true;

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const idx   = i;  // クロージャ用
    const circle = L.circleMarker([photo.lat, photo.lon], {
      radius: settings.markerRadius,
      ...MARKER_DEFAULT,
    });
    circle.bindTooltip(photo.filename, { direction: "top", offset: [0, -10] });
    circle.on("click", () => selectPhoto(idx, { openWindow: true }));
    circle.addTo(map);
    photoLayers.push(circle);
    photoData.push(photo);
  }

  if (photos.length === 0) {
    hideProgress();
    alert("GPS 情報を持つ JPEG が見つかりませんでした。");
    return;
  }

  const bounds = L.latLngBounds(photos.map((p) => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [50, 50] });
  map.once("moveend", () => map.setZoom(Math.min(map.getZoom() + 2, 18)));
  updateLayersPanel();
  hideProgress();
};

// ----------------------------------------------------------------
// 写真ウィンドウ（独立 BrowserWindow として開く）
// ----------------------------------------------------------------
function openPhotoWindow(photo, { focus = true } = {}) {
  window.api.openPhotoWindow({ photoId: photo.id, filename: photo.filename, focus });
}

// ----------------------------------------------------------------
// 設定パネル
// ----------------------------------------------------------------
const settingsPanel = document.getElementById("settings-panel");

document.getElementById("settings-btn").onclick = (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle("hidden");
};

// パネル外クリックで閉じる
document.addEventListener("click", (e) => {
  if (!settingsPanel.contains(e.target) && e.target.id !== "settings-btn") {
    settingsPanel.classList.add("hidden");
  }
});

// 黒画素透過トグル
const transparentToggle   = document.getElementById("transparent-black");
const thresholdRow        = document.getElementById("threshold-row");
const thresholdSlider     = document.getElementById("black-threshold");
const thresholdValueLabel = document.getElementById("threshold-value");

transparentToggle.checked = settings.transparentBlack;
thresholdSlider.value     = settings.blackThreshold;
thresholdValueLabel.textContent = settings.blackThreshold;
thresholdRow.style.opacity = settings.transparentBlack ? "1" : "0.4";

transparentToggle.onchange = () => {
  settings.transparentBlack = transparentToggle.checked;
  thresholdRow.style.opacity = settings.transparentBlack ? "1" : "0.4";
  if (currentGeoraster) applyTiffLayer(currentGeoraster);
};

thresholdSlider.oninput = () => {
  settings.blackThreshold = Number(thresholdSlider.value);
  thresholdValueLabel.textContent = settings.blackThreshold;
};

thresholdSlider.onchange = () => {
  if (currentGeoraster) applyTiffLayer(currentGeoraster);
};

// ----------------------------------------------------------------
// クリック座標表示
// ----------------------------------------------------------------
const coordBar      = document.getElementById("coord-bar");
const coordText     = document.getElementById("coord-text");
const coordHint     = document.getElementById("coord-copy-hint");

map.on("click", (e) => {
  // マーカークリック直後は無視（二重処理防止）
  if (_suppressMapClick) return;

  const lat = e.latlng.lat.toFixed(6);
  const lng = e.latlng.lng.toFixed(6);
  coordText.textContent = `${lat}, ${lng}`;
  coordBar.classList.remove("hidden", "copied");

  // 編集モード中: 新しいポイントを追加
  if (editingLayerId) {
    const item = vectorLayers.find(v => v.id === editingLayerId);
    if (!item) return;
    const marker = L.circleMarker(e.latlng, {
      radius: settings.vectorMarkerRadius, fillColor: item.color, fillOpacity: 0.8, color: "#ffffff", weight: 1.5,
    });
    // toGeoJSON() が正しく動作するよう feature を設定
    marker.feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [e.latlng.lng, e.latlng.lat] },
      properties: {},
    };
    item.layer.addLayer(marker);
  }
});

coordBar.addEventListener("click", () => {
  navigator.clipboard.writeText(coordText.textContent).then(() => {
    coordHint.textContent = "コピーしました！";
    coordBar.classList.add("copied");
    setTimeout(() => {
      coordHint.textContent = "クリックでコピー";
      coordBar.classList.remove("copied");
    }, 1500);
  });
});

// ----------------------------------------------------------------
// マーカーサイズスライダー
const markerSlider     = document.getElementById("marker-radius");
const markerValueLabel = document.getElementById("marker-radius-value");

markerSlider.value              = settings.markerRadius;
markerValueLabel.textContent    = settings.markerRadius;

markerSlider.oninput = () => {
  settings.markerRadius = Number(markerSlider.value);
  markerValueLabel.textContent = settings.markerRadius;
  photoLayers.forEach((l) => l.setRadius(settings.markerRadius));
};

// Vector マーカーサイズスライダー
const vectorMarkerSlider      = document.getElementById("vector-marker-radius");
const vectorMarkerValueLabel  = document.getElementById("vector-marker-radius-value");

vectorMarkerSlider.value             = settings.vectorMarkerRadius;
vectorMarkerValueLabel.textContent   = settings.vectorMarkerRadius;

vectorMarkerSlider.oninput = () => {
  settings.vectorMarkerRadius = Number(vectorMarkerSlider.value);
  vectorMarkerValueLabel.textContent = settings.vectorMarkerRadius;
  // 既存の全 Vector レイヤーのマーカーにリアルタイム反映
  vectorLayers.forEach(({ layer }) => {
    layer.eachLayer((l) => {
      if (l.setRadius) l.setRadius(settings.vectorMarkerRadius);
    });
  });
};
