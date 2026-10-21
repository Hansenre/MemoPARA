// Monta um PDF a partir de JPEGs sem dependências: cada página recebe a imagem
// inteira (o JPEG entra como está, com filtro DCTDecode, sem recompressão).

const A4_SHORT = 595.28;
const A4_LONG = 841.89;

// Lê largura, altura e número de componentes do marcador SOF de um JPEG.
export function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Arquivo não é um JPEG válido.');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  throw new Error('JPEG sem dimensões.');
}

function pdfString(text) {
  // UTF-16BE com BOM, em hexadecimal: aceita acentos em qualquer leitor
  const hex = Buffer.from(`﻿${text}`, 'utf16le').swap16().toString('hex');
  return `<${hex}>`;
}

export function buildPdf(images, { title = 'Apostila', created = new Date() } = {}) {
  if (!images.length) throw new Error('Sem páginas para gerar o PDF.');
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
    chunks.push(b);
    length += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    for (const part of [].concat(body)) push(part);
    push('\nendobj\n');
  };

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  // 1 = catálogo, 2 = árvore de páginas, 3 = info; cada página usa 3 objetos (página, conteúdo, imagem)
  const pageIds = images.map((_, i) => 4 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`);
  const d = created;
  const pad = (n) => String(n).padStart(2, '0');
  const pdfDate = `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  obj(3, `<< /Title ${pdfString(title)} /Producer (MemoPARA) /CreationDate (${pdfDate}) >>`);

  images.forEach((jpeg, i) => {
    const { width, height, components } = jpegInfo(jpeg);
    const colorSpace = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    // a página acompanha a proporção da foto, com o lado menor do tamanho de um A4
    const portrait = height >= width;
    const pw = portrait ? A4_SHORT : A4_LONG;
    const ph = +(pw * height / width).toFixed(2);
    const [pageId, contentId, imageId] = [pageIds[i], pageIds[i] + 1, pageIds[i] + 2];
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    obj(contentId, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode${components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''} /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream'
    ]);
  });

  const xref = length;
  const count = offsets.length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
