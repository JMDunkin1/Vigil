const SVG_NS = "http://www.w3.org/2000/svg";

type QrMatrix = boolean[][];
type QrSetter = (x: number, y: number, value: boolean | number, reserve?: boolean) => void;
type QrReserve = (x: number, y: number) => void;

export function createDistanceKeyQrSvg(token: unknown, cell = 6, doc: Document = document): SVGSVGElement {
  const matrix = distanceKeyQrMatrix(normalizeDistanceKeyTokenForQr(token));
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", `0 0 ${size * cell} ${size * cell}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Distance key QR code");

  const background = doc.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", "#fff");
  svg.append(background);

  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute("fill", "#16201d");
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (!matrix[y][x]) continue;
      const rect = doc.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String((x + quiet) * cell));
      rect.setAttribute("y", String((y + quiet) * cell));
      rect.setAttribute("width", String(cell));
      rect.setAttribute("height", String(cell));
      group.append(rect);
    }
  }
  svg.append(group);
  return svg;
}

export function distanceKeyQrMatrix(token: string): QrMatrix {
  const data = qrDataCodewords(token);
  const ecc = qrReedSolomon(data, 7);
  const bits = qrCodewordBits([...data, ...ecc]);
  const size = 21;
  const modules: QrMatrix = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const reserved: QrMatrix = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const set: QrSetter = (x, y, value, reserve = true) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = Boolean(value);
    if (reserve) reserved[y][x] = true;
  };
  const reserve: QrReserve = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved[y][x] = true;
  };

  drawQrFinder(set, 0, 0);
  drawQrFinder(set, size - 7, 0);
  drawQrFinder(set, 0, size - 7);
  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  set(8, 13, true);
  reserveQrFormatAreas(reserve, size);

  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let dx = 0; dx < 2; dx += 1) {
        const x = right - dx;
        if (reserved[y][x]) continue;
        let bit = bits[bitIndex] || 0;
        if ((x + y) % 2 === 0) bit ^= 1;
        modules[y][x] = Boolean(bit);
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  drawQrFormat(set, size);
  return modules;
}

function drawQrFinder(set: QrSetter, x: number, y: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const inPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inPattern && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      set(x + dx, y + dy, dark);
    }
  }
}

function reserveQrFormatAreas(reserve: QrReserve, size: number): void {
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      reserve(8, i);
      reserve(i, 8);
    }
  }
  for (let i = 0; i < 8; i += 1) reserve(size - 1 - i, 8);
  for (let i = 8; i < 15; i += 1) reserve(8, size - 15 + i);
}

function drawQrFormat(set: QrSetter, size: number): void {
  const bits = 0x77c4;
  const bit = (index: number): boolean => ((bits >>> index) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
}

function qrDataCodewords(token: string): number[] {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  const bits: number[] = [];
  if (token.length > 25 || [...token].some((char) => !alphabet.includes(char))) {
    throw new Error("Distance key token cannot be encoded as a compact QR code");
  }
  addQrBits(bits, 0b0010, 4);
  addQrBits(bits, token.length, 9);
  for (let i = 0; i < token.length; i += 2) {
    const first = alphabet.indexOf(token[i]);
    if (i + 1 < token.length) addQrBits(bits, first * 45 + alphabet.indexOf(token[i + 1]), 11);
    else addQrBits(bits, first, 6);
  }
  const capacity = 19 * 8;
  addQrBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((value, next) => (value << 1) | next, 0));
  }
  for (let pad = 0xec; data.length < 19; pad = pad === 0xec ? 0x11 : 0xec) data.push(pad);
  return data;
}

function addQrBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function qrCodewordBits(codewords: number[]): number[] {
  const bits: number[] = [];
  for (const codeword of codewords) addQrBits(bits, codeword, 8);
  return bits;
}

function qrReedSolomon(data: number[], degree: number): number[] {
  const generator = qrRsGenerator(degree);
  const result: number[] = Array<number>(degree).fill(0);
  for (const value of data) {
    const factor = value ^ (result.shift() || 0);
    result.push(0);
    for (let i = 0; i < generator.length; i += 1) {
      result[i] ^= qrGfMultiply(generator[i], factor);
    }
  }
  return result;
}

function qrRsGenerator(degree: number): number[] {
  let poly: number[] = [1];
  for (let i = 0; i < degree; i += 1) {
    const root = qrGfPow(2, i);
    const next: number[] = Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= qrGfMultiply(poly[j], root);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.slice(1);
}

function qrGfPow(value: number, power: number): number {
  let result = 1;
  for (let i = 0; i < power; i += 1) result = qrGfMultiply(result, value);
  return result;
}

function qrGfMultiply(left: number, right: number): number {
  let result = 0;
  for (let i = 0; i < 8; i += 1) {
    if ((right & 1) !== 0) result ^= left;
    const carry = left & 0x80;
    left = (left << 1) & 0xff;
    if (carry) left ^= 0x1d;
    right >>>= 1;
  }
  return result;
}

function normalizeDistanceKeyTokenForQr(token: unknown): string {
  return String(token || "").trim().toUpperCase().replace(/\s+/g, "");
}
