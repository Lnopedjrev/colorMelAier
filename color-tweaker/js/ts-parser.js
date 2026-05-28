// Parses TypeScript interface/type declarations and generates mock data

export function parseTypeScript(code) {
  code = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const types = {};
  const re = /(?:export\s+)?(?:interface|type)\s+(\w+)(?:<[^>]*>)?\s*=?\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    let depth = 1, i = m.index + m[0].length;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    types[name] = parseTypeBody(code.substring(m.index + m[0].length, i - 1));
  }
  return types;
}

function parseTypeBody(body) {
  const result = {};
  const lines = body.split(/[;\n]/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const pm = line.match(/^(\w+)\??\s*:\s*(.+)$/);
    if (!pm) continue;
    let typeStr = pm[2].trim();
    if (typeStr.endsWith(',')) typeStr = typeStr.slice(0, -1).trim();
    result[pm[1]] = typeStr;
  }
  return result;
}

export function generateMock(typeStr, allTypes, depth) {
  if ((depth || 0) > 5) return null;
  typeStr = typeStr.trim();

  if (typeStr === 'string') return 'sample';
  if (typeStr === 'number') return 1;
  if (typeStr === 'boolean') return true;
  if (typeStr === 'null' || typeStr === 'undefined') return null;
  if (typeStr === 'any' || typeStr === 'unknown' || typeStr === 'object') return {};

  if (typeStr.endsWith('[]'))
    return [generateMock(typeStr.slice(0, -2), allTypes, (depth || 0) + 1)];

  const arrM = typeStr.match(/^Array<(.+)>$/);
  if (arrM) return [generateMock(arrM[1], allTypes, (depth || 0) + 1)];

  if (typeStr.includes('|')) {
    const parts = typeStr.split('|').map(s => s.trim()).filter(s => s !== 'null' && s !== 'undefined');
    return generateMock(parts[0] || 'null', allTypes, (depth || 0) + 1);
  }

  if (allTypes[typeStr]) {
    const obj = {};
    for (const [k, v] of Object.entries(allTypes[typeStr]))
      obj[k] = generateMock(v, allTypes, (depth || 0) + 1);
    return obj;
  }

  if (typeStr.startsWith('{') && typeStr.endsWith('}')) {
    const inner = parseTypeBody(typeStr.slice(1, -1));
    const obj = {};
    for (const [k, v] of Object.entries(inner))
      obj[k] = generateMock(v, allTypes, (depth || 0) + 1);
    return obj;
  }

  return null;
}

export function generateMockForType(typeName, allTypes) {
  if (!allTypes[typeName]) return null;
  const obj = {};
  for (const [k, v] of Object.entries(allTypes[typeName]))
    obj[k] = generateMock(v, allTypes, 0);
  return obj;
}
