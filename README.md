# ColorTweaker

ColorTweaker loads inline HTML/CSS/JavaScript, a website URL, or a local production build into an iframe. It finds colors in the loaded CSS, exposes them through color and alpha controls, applies changes to the preview immediately, exports the resulting CSS, and can record up to five seconds of preview interaction for download or optional endpoint scoring.

## Parsing and work regimes

### Inline editor

The HTML, CSS, and JavaScript editors are used to generate the iframe document. CSS is parsed as one source. Editing HTML or JavaScript reloads the generated preview, while CSS color changes are applied directly to its stylesheet.

### Website URL: direct access

For a same-origin URL, ColorTweaker accesses the iframe document directly. It parses `<style>` elements, accessible linked stylesheets, inline `style` attributes, adopted stylesheets, and the same sources inside open shadow roots. Runtime stylesheet changes are observed and reparsed.

### Website URL: bridge access

For a cross-origin URL, direct iframe access is blocked by the browser. If the target site includes `color-tweaker-bridge.js`, the bridge parses CSS inside the target page and sends the sources to ColorTweaker. It also applies CSS updates and reports runtime source changes.

Without the bridge, cross-origin CSS cannot be parsed. The site must also permit iframe embedding.

### Uploaded production build

ColorTweaker accepts a local build directory and finds its HTML entry point. Linked CSS is converted into separately tracked style sources, local CSS imports are expanded, asset URLs are converted to object URLs, and JavaScript module paths are rewritten through an import map. Inline style attributes are parsed as separate sources. The transformed build is then loaded into the iframe.

### CSS source parsing

All loading regimes use the same declaration-aware color parser. It detects hexadecimal, named, functional, and CSS-variable color values while ignoring comments, quoted strings, and `url(...)` contents. Each occurrence retains its source ID and exact position so replacements can be applied only to the relevant text.

When a URL or build provides multiple CSS sources, they are shown together in the CSS editor with source-marker comments. These markers preserve the boundary between stylesheets when edited CSS is parsed and applied back to the preview.

In URL and build regimes, CSS remains editable. The HTML and JavaScript tabs are guarded because confirming either tab switches back to the inline-editor regime and replaces the loaded iframe content.
