# GeofileViewer

A lightweight desktop viewer for GeoTIFF, GeoJSON, and geotagged photos — built for field researchers and GIS practitioners who want to open and inspect spatial data instantly without launching a full GIS suite.

![screenshot](docs/screenshot.png)

## Why this exists

QGIS is powerful, but opening it just to check a GeoTIFF or browse some geotagged drone photos is overkill. GeofileViewer is designed for that use case: **double-click a file, see it on a map, move on.**

| | GeofileViewer | QGIS |
|---|---|---|
| Startup time | ~1 second | 5–15 seconds |
| GeoTIFF display | Drag & drop, immediate | Project setup required |
| Zoom performance | Tile-based, smooth | Depends on file size and renderer |
| GeoJSON editing | Basic (add/delete points, save) | Full feature editing |
| Photo location check | Built-in, arrow key navigation | Requires plugin or manual import |
| Coordinate copy | Click anywhere on map | Multiple steps |
| Installation | `npm install && npm start` | 200 MB+ installer |
| Target user | Quick field check / data QA | Full GIS analysis |

GeofileViewer does not replace QGIS for analysis work. It fills the gap when you just need to **see** the data.

## Features

**GeoTIFF**
- Opens and displays rasters reprojected to web tiles
- Transparent black pixel option for drone/satellite imagery with dark borders
- Fits the map to the raster extent automatically

**GeoJSON vectors**
- Renders point, line, and polygon layers
- Per-layer visibility toggle, color picker, and marker size control
- Edit mode: add points by clicking the map, delete selected points, save back to file

**Geotagged photos**
- Reads GPS coordinates from EXIF (JPEG/HEIC)
- Plots photo locations as markers on the map
- Click or use arrow keys to navigate between photos; photo viewer opens in a separate window without stealing focus

**General**
- Click anywhere on the map to show lat/lon coordinates, click to copy
- Base maps: Esri World Imagery (aerial), CartoDB Dark, CartoDB Voyager
- Layer panel with visibility checkboxes for all loaded content

## Requirements

- Node.js 18+
- npm

GDAL (`gdalinfo`, `gdal2tiles`) is optional and used as a fallback for certain coordinate reprojection cases.

## Getting started

```
git clone https://github.com/your-username/GeofileViewer.git
cd GeofileViewer/geofileViewer
npm install
npm start
```

## Build

```
# macOS (dmg)
npm run build:mac

# Windows portable exe (cross-compiled from macOS)
npm run build:win
```

Output goes to `dist/`.

## Usage

1. **GeoTIFF** — Click the GeoTIFF button and select a `.tif` file. The raster is tiled and the map fits to its bounds.
2. **Photo** — Click Photo and select a folder of geotagged images. Markers appear at each photo's GPS location. Click a marker or use arrow keys to navigate.
3. **Vector** — Click Vector and select a `.geojson` file. Use the layer panel on the left to toggle visibility, change color, or enter edit mode to add/delete points and save.
4. **Settings (gear icon)** — Adjust black-pixel transparency threshold and marker sizes.
5. **Coordinates** — Click anywhere on the map. The lat/lon appears at the bottom; click it to copy to clipboard.

## Tech stack

| Library | Role |
|---|---|
| [Electron](https://www.electronjs.org/) | Desktop shell |
| [Leaflet](https://leafletjs.com/) | Map rendering |
| [geotiff.js](https://geotiffjs.github.io/) | GeoTIFF parsing |
| [georaster-layer-for-leaflet](https://github.com/GeoTIFF/georaster-layer-for-leaflet) | Raster tile overlay |
| [proj4](https://github.com/proj4js/proj4js) | Coordinate reprojection |
| [pngjs](https://github.com/lukeapage/pngjs) | PNG tile encoding |
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF/GPS extraction from photos |

## License

MIT
