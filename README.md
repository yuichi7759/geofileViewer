# GeofileViewer

A desktop GIS viewer built with Electron. Supports GeoTIFF rasters, geotagged photos, and GeoJSON vector layers on an interactive map.

## Features

- **GeoTIFF**: Opens and reprojects rasters to web mercator tiles for display. Transparency control for black pixels.
- **Photos**: Loads geotagged JPEG/HEIC files, plots them as markers on the map. Arrow key navigation between photos with a separate photo viewer window.
- **GeoJSON vectors**: Loads and renders point/line/polygon layers. Supports in-app editing (add/delete points) and saving back to file.
- **Layer control**: Toggle visibility of each layer independently. Adjust marker sizes and colors per layer.
- **Coordinate display**: Click anywhere on the map to show lat/lon, click to copy.
- **Base maps**: CartoDB Dark, CartoDB Voyager, Esri World Imagery.

## Requirements

- Node.js 18+
- npm

Optional, for GeoTIFF reprojection fallback:

- GDAL (`gdalinfo`, `gdal2tiles`)

## Getting started

```
npm install
npm start
```

## Build

```
# macOS (dmg)
npm run build:mac

# Windows (portable exe, cross-compiled from macOS)
npm run build:win
```

Output goes to `dist/`.

## Usage

1. Click **GeoTIFF** to load a raster file. The app reprojects it to tiles and fits the map to its extent.
2. Click **Photo** to load a directory of geotagged photos. Markers appear at each photo's GPS location. Click a marker or use arrow keys to navigate.
3. Click **Vector** to load a GeoJSON file. Use the panel on the left to toggle visibility, change color, or enter edit mode to add/delete points and save.
4. Click the **gear icon** to adjust transparency thresholds and marker sizes.

## Tech stack

| Library | Role |
|---|---|
| [Electron](https://www.electronjs.org/) | Desktop shell |
| [Leaflet](https://leafletjs.com/) | Map rendering |
| [geotiff.js](https://geotiffjs.github.io/) | GeoTIFF parsing |
| [georaster-layer-for-leaflet](https://github.com/GeoTIFF/georaster-layer-for-leaflet) | Raster overlay |
| [proj4](https://github.com/proj4js/proj4js) | Coordinate reprojection |
| [pngjs](https://github.com/lukeapage/pngjs) | PNG tile encoding |
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF/GPS extraction |

## License

MIT
