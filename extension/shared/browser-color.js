export const NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
  "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
  "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
  "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue", "darkcyan",
  "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
  "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred",
  "darksalmon", "darkseagreen", "darkslateblue", "darkslategray",
  "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite",
  "forestgreen", "fuchsia", "gainsboro", "ghostwhite", "gold", "goldenrod",
  "gray", "green", "greenyellow", "grey", "honeydew", "hotpink",
  "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush",
  "lawngreen", "lemonchiffon", "lightblue", "lightcoral", "lightcyan",
  "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink",
  "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
  "lightslategrey", "lightsteelblue", "lightyellow", "lime", "limegreen",
  "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace",
  "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod",
  "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red",
  "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown",
  "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue",
  "slategray", "slategrey", "snow", "springgreen", "steelblue", "tan",
  "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen",
]);

const SKIPPED_COLOR_VALUES = new Set([
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "none",
]);

/**
 * Creates DOM-backed CSS color conversion functions for a browser document.
 * Keeping document access inside this factory makes importing shared modules
 * safe in the extension service worker.
 */
export function createBrowserColorAdapter(documentRef) {
  if (!documentRef?.createElement) {
    throw new TypeError("createBrowserColorAdapter requires a Document");
  }
  const context = documentRef.createElement("canvas").getContext("2d");

  function isValidColor(value) {
    if (!value || SKIPPED_COLOR_VALUES.has(value.toLowerCase().trim())) {
      return false;
    }
    const style = documentRef.createElement("option").style;
    style.color = value.trim();
    return style.color !== "";
  }

  function toCanonical(color) {
    if (!isValidColor(color)) return null;
    context.fillStyle = "#010203";
    context.fillStyle = color.trim();
    const firstParse = context.fillStyle;
    context.fillStyle = "#040506";
    context.fillStyle = color.trim();
    const secondParse = context.fillStyle;
    if (firstParse !== secondParse) return null;

    context.clearRect(0, 0, 1, 1);
    context.fillStyle = firstParse;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (alpha === 0) {
      const transparent = firstParse.match(
        /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)\D+0(?:\.0+)?\s*\)/,
      );
      return transparent
        ? `rgba(${transparent[1]}, ${transparent[2]}, ${transparent[3]}, 0)`
        : null;
    }
    if (alpha < 255) {
      return `rgba(${red}, ${green}, ${blue}, ${Math.round((alpha / 255) * 1000) / 1000})`;
    }
    return `#${[red, green, blue]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function canonicalToHex6(canonical) {
    if (canonical.startsWith("#")) return canonical;
    const match = canonical.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return "#000000";
    return `#${[match[1], match[2], match[3]]
      .map((channel) => parseInt(channel, 10).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function extractAlpha(value) {
    const trimmed = value.trim();
    const hex =
      trimmed.match(/^#[0-9a-f]{3}([0-9a-f])$/i) ||
      trimmed.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i);
    if (hex) {
      const alpha = hex[1].length === 1 ? hex[1] + hex[1] : hex[1];
      return parseInt(alpha, 16) / 255;
    }

    const slashAlpha = trimmed.match(/\/\s*([\d.]+)(%)?\s*\)\s*$/);
    if (slashAlpha) {
      const alpha = parseFloat(slashAlpha[1]);
      return slashAlpha[2] ? alpha / 100 : alpha;
    }

    const commaAlpha = /^(?:rgba|hsla)\(/i.test(trimmed)
      ? trimmed.match(/,\s*([\d.]+)(%)?\s*\)\s*$/)
      : null;
    if (commaAlpha) {
      const alpha = parseFloat(commaAlpha[1]);
      return commaAlpha[2] ? alpha / 100 : alpha;
    }

    const canonical = toCanonical(trimmed);
    const normalized =
      canonical &&
      canonical.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
    return normalized ? parseFloat(normalized[1]) : null;
  }

  function hexToRgba(hex6, alpha) {
    const red = parseInt(hex6.slice(1, 3), 16);
    const green = parseInt(hex6.slice(3, 5), 16);
    const blue = parseInt(hex6.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  return {
    isValidColor,
    toCanonical,
    canonicalToHex6,
    extractAlpha,
    hexToRgba,
  };
}
