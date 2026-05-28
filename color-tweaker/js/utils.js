// Color constants, conversion utilities, and helpers

export const NAMED_COLORS = new Set([
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque','black',
  'blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue','chartreuse',
  'chocolate','coral','cornflowerblue','cornsilk','crimson','cyan','darkblue',
  'darkcyan','darkgoldenrod','darkgray','darkgreen','darkgrey','darkkhaki',
  'darkmagenta','darkolivegreen','darkorange','darkorchid','darkred','darksalmon',
  'darkseagreen','darkslateblue','darkslategray','darkslategrey','darkturquoise',
  'darkviolet','deeppink','deepskyblue','dimgray','dimgrey','dodgerblue','firebrick',
  'floralwhite','forestgreen','fuchsia','gainsboro','ghostwhite','gold','goldenrod',
  'gray','green','greenyellow','grey','honeydew','hotpink','indianred','indigo',
  'ivory','khaki','lavender','lavenderblush','lawngreen','lemonchiffon','lightblue',
  'lightcoral','lightcyan','lightgoldenrodyellow','lightgray','lightgreen','lightgrey',
  'lightpink','lightsalmon','lightseagreen','lightskyblue','lightslategray',
  'lightslategrey','lightsteelblue','lightyellow','lime','limegreen','linen','magenta',
  'maroon','mediumaquamarine','mediumblue','mediumorchid','mediumpurple',
  'mediumseagreen','mediumslateblue','mediumspringgreen','mediumturquoise',
  'mediumvioletred','midnightblue','mintcream','mistyrose','moccasin','navajowhite',
  'navy','oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod',
  'palegreen','paleturquoise','palevioletred','papayawhip','peachpuff','peru','pink',
  'plum','powderblue','purple','rebeccapurple','red','rosybrown','royalblue',
  'saddlebrown','salmon','sandybrown','seagreen','seashell','sienna','silver',
  'skyblue','slateblue','slategray','slategrey','snow','springgreen','steelblue',
  'tan','teal','thistle','tomato','turquoise','violet','wheat','white','whitesmoke',
  'yellow','yellowgreen'
]);

const SKIP = new Set([
  'transparent','currentcolor','inherit','initial','unset','revert','none'
]);

const _ctx = document.createElement('canvas').getContext('2d');

export function isValidColor(str) {
  if (!str || SKIP.has(str.toLowerCase().trim())) return false;
  const s = new Option().style;
  s.color = str.trim();
  return s.color !== '';
}

export function toCanonical(color) {
  if (!isValidColor(color)) return null;
  _ctx.fillStyle = '#000000';
  _ctx.fillStyle = color.trim();
  return _ctx.fillStyle;
}

export function canonicalToHex6(c) {
  if (c.startsWith('#')) return c;
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return '#' + [m[1], m[2], m[3]].map(v => parseInt(v).toString(16).padStart(2, '0')).join('');
  return '#000000';
}

export function extractAlpha(str) {
  const m = str.match(/,\s*([\d.]+)\s*\)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

export function hexToRgba(hex6, alpha) {
  const r = parseInt(hex6.slice(1, 3), 16);
  const g = parseInt(hex6.slice(3, 5), 16);
  const b = parseInt(hex6.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function entryHasAlpha(entry) {
  for (const orig of entry.originals) {
    if (extractAlpha(orig) !== null) return true;
  }
  return false;
}

export function getEntryAlpha(entry, alphaOverrides) {
  if (alphaOverrides.has(entry.canonical)) return alphaOverrides.get(entry.canonical);
  for (const orig of entry.originals) {
    const a = extractAlpha(orig);
    if (a !== null) return a;
  }
  return 1;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
