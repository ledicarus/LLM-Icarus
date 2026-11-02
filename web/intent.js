// Turns "some files dropped into the box plus a sentence" into the request each mode needs. No page code in here,
// so it can be tried from Node. planJob() returns { requests: [{ url, body }] } or { error }.

const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i;
const VIDEO = /\.(mp4|mkv|mov|avi|webm|m4v|wmv)$/i;
const IMAGE = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

export const kindOf = (name) => (AUDIO.test(name) ? 'audio' : VIDEO.test(name) ? 'video' : IMAGE.test(name) ? 'image' : 'other');

const LANGUAGES = { english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl', japanese: 'ja', chinese: 'zh' };

export function languageFrom(text) {
  const m = new RegExp(`\\b(?:in|from|language[: ]+)\\s*(${Object.keys(LANGUAGES).join('|')})\\b`, 'i').exec(text) || new RegExp(`^\\s*(${Object.keys(LANGUAGES).join('|')})\\s*$`, 'i').exec(text);
  return m ? LANGUAGES[m[1].toLowerCase()] : 'auto';
}

const toMm = (n, unit) => {
  const v = parseFloat(n);
  const u = (unit || 'mm').toLowerCase();
  return Math.round(v * (u === 'cm' ? 10 : u.startsWith('in') ? 25.4 : 1) * 100) / 100;
};

const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '(mm|cm|inch(?:es)?|in)';

// "40 x 20 x 15 mm" is width x depth x height; "40 mm wide", "height 15", "20cm tall" name one side each.
export function sizesFrom(text) {
  const size = {};
  const box = new RegExp(`${NUM}\\s*${UNIT}?\\s*[x×*]\\s*${NUM}\\s*${UNIT}?\\s*[x×*]\\s*${NUM}\\s*${UNIT}?`, 'i').exec(text);
  if (box) {
    const unit = box[6] || box[4] || box[2];
    Object.assign(size, { x: toMm(box[1], unit), y: toMm(box[3], unit), z: toMm(box[5], unit) });
  }
  const sides = { x: 'wide|width|across', y: 'deep|depth|long|length', z: 'tall|high|height' };
  for (const [axis, words] of Object.entries(sides)) {
    if (size[axis]) continue;
    const after = new RegExp(`${NUM}\\s*${UNIT}?\\s*(?:${words})\\b`, 'i').exec(text);
    const before = new RegExp(`\\b(?:${words})\\s*(?:of|is|:|=)?\\s*${NUM}\\s*${UNIT}?`, 'i').exec(text);
    if (after) size[axis] = toMm(after[1], after[2]);
    else if (before) size[axis] = toMm(before[1], before[2]);
  }
  return size;
}

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4 };

function imageOptions(text) {
  const out = { width: 1024, height: 1024 };
  const wh = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(text);
  if (wh) [out.width, out.height] = [+wh[1], +wh[2]];
  else if (/\b(portrait|tall|vertical)\b/i.test(text)) [out.width, out.height] = [832, 1216];
  else if (/\b(landscape|widescreen|horizontal|wide)\b/i.test(text)) [out.width, out.height] = [1216, 832];
  const n = /\b(\d|one|two|three|four)\s+(?:different\s+)?(?:images|pictures|variations|versions|options)\b/i.exec(text);
  if (n) out.count = Math.min(4, Math.max(1, NUMBER_WORDS[n[1].toLowerCase()] || +n[1]));
  const seed = /\bseed\s*[:=]?\s*(\d+)/i.exec(text);
  if (seed) out.seed = +seed[1];
  return out;
}

function tdViewsFrom(images) {
  const views = {};
  const rest = [];
  for (const f of images) {
    const name = f.name.toLowerCase();
    const slot = /front/.test(name) ? 'front' : /side|right/.test(name) ? 'side' : /top|above|plan/.test(name) ? 'top' : null;
    if (slot && !views[slot]) views[slot] = f.path;
    else rest.push(f);
  }
  for (const slot of ['front', 'side', 'top']) if (!views[slot] && rest.length) views[slot] = rest.shift().path;
  return views;
}

// Long rounded things (a banana, a carrot, a bone) are not drawn well by a model writing CAD code, so with no pictures dropped
// they are made from a picture the image model draws of the object (the "sweep" method). Mechanical parts and edits go to OpenSCAD.
const MECHANICAL = /\b(bracket|holder|box|case|cover|mount|adapter|gear|bolt|screw|nut|holes?|thread(?:ed)?|walls?|hinge|clip|stand|tray|cup|plate|enclosure|lid|handle|knob|spacer|washer|tube|pipe|hook|stl script|openscad|script)\b/i;
const LONG_ROUND = /\b(banana|carrot|cucumber|zucchini|courgette|sausage|hot ?dog|baguette|bone|horn|tusk|eggplant|aubergine|pickle|chil+i|parsnip|radish|leek|snake|worm|caterpillar|sweet potato|cigar|pea ?pod|green bean)s?\b/i;
const FROM_PICTURE = /\bfrom a (?:generated )?(?:picture|photo)\b/i;

export function wantsSweep(text, ctx = {}) {
  if (ctx.base || !ctx.imageModelId || !ctx.sdxlReady) return false;
  if (/\b(openscad|script|with the model)\b/i.test(text)) return false;
  if (FROM_PICTURE.test(text) && !/\b(bracket|box|case|mount|gear|hinge|clip|tray|lid)\b/i.test(text)) return true;
  return LONG_ROUND.test(text) && !MECHANICAL.test(text);
}

// ctx: { llmId, imageModelId, sdxlReady, base }  (base = the earlier result this message should edit, if any)
export function planJob(mode, text, files, ctx = {}) {
  text = (text || '').trim();
  const of = (kind) => files.filter((f) => kindOf(f.name) === kind || (kind === 'image' && f.path.startsWith('image:')));

  if (mode === 'transcribe') {
    const media = files.filter((f) => ['audio', 'video'].includes(kindOf(f.name)));
    if (!media.length) return { error: 'Drop an audio or video file into the box first (or click the paperclip).' };
    if (media.length < files.length) return { error: 'Only audio and video files can be transcribed. Remove the other files.' };
    const language = languageFrom(text);
    return { requests: media.map((f) => ({ url: '/api/transcribe', body: { path: f.path, language } })) };
  }

  if (mode === 'image') {
    const pics = of('image');
    if (!text) return { error: pics.length ? 'Say what to change in the picture.' : 'Describe the picture you want.' };
    if (!ctx.imageModelId) return { error: 'There is no image model yet. Open Advanced options to download one.' };
    const o = imageOptions(text);
    return { requests: [{ url: '/api/image', body: { modelId: ctx.imageModelId, prompt: text, ...o, ...(pics[0] && { initImage: pics[0].path, strength: 0.6 }) } }] };
  }

  if (mode === 'vector') {
    const pic = of('image')[0];
    if (files.length > (pic ? 1 : 0)) return { error: 'Vector takes one picture at most.' };
    const binary = /\b(black and white|black-and-white|b&w|monochrome|one colou?r|single colou?r|silhouette|stencil|line ?art)\b/i.test(text);
    const detail = /\b(very detailed|highly detailed|fine detail|lots of detail)\b/i.test(text) ? 5 : /\b(simple|rough|low detail|minimal)\b/i.test(text) ? 2 : 3;
    const w = new RegExp(`${NUM}\\s*${UNIT}\\s*(?:wide|across|width)|width\\s*(?:of|is|:|=)?\\s*${NUM}\\s*${UNIT}`, 'i').exec(text);
    const widthMm = w ? toMm(w[1] || w[3], w[2] || w[4]) : undefined;
    const base = { colormode: binary ? 'binary' : 'color', detail, widthMm, thinking: true };
    const aspect = /\b(portrait|tall|vertical)\b/i.test(text) ? 'tall' : /\b(landscape|wide|horizontal)\b/i.test(text) ? 'wide' : 'square';
    if (pic) {
      const guide = ctx.sdxlReady && /\b(style|inspired|similar|like this|based on|reference|redraw|reimagine)\b/i.test(text);
      if (guide) return { requests: [{ url: '/api/vector', body: { ...base, method: 'sdxl', prompt: text, reference: pic.path, imageModelId: ctx.imageModelId, removeBackground: true, strength: 0.6 } }] };
      const nobg = /\b(transparent|(?:no|remove|without)\b[^.]*\bbackground)\b/i.test(text);
      return { requests: [{ url: '/api/vector', body: { ...base, method: 'trace', reference: pic.path, removeBackground: nobg } }] };
    }
    if (!text) return { error: 'Drop a picture to trace, or describe the drawing you want.' };
    if (ctx.base) return { requests: [{ url: '/api/vector', body: { ...base, method: 'llm', prompt: text, modelId: ctx.llmId, baseJob: ctx.base, aspect } }] };
    if (ctx.sdxlReady) return { requests: [{ url: '/api/vector', body: { ...base, method: 'sdxl', prompt: text, imageModelId: ctx.imageModelId, removeBackground: true } }] };
    if (!ctx.llmId) return { error: 'Add a chat model first (Settings > Models).' };
    return { requests: [{ url: '/api/vector', body: { ...base, method: 'llm', prompt: text, modelId: ctx.llmId, aspect } }] };
  }

  if (mode === '3d') {
    const pics = of('image');
    if (files.length > pics.length) return { error: 'Drop pictures only (front, side and top views), or describe the part.' };
    const sizeMm = sizesFrom(text);
    if (pics.length) {
      const views = tdViewsFrom(pics.slice(0, 3));
      const quality = /\b(fine|high detail|high quality)\b/i.test(text) ? 3 : /\b(draft|fast|quick)\b/i.test(text) ? 1 : 2;
      const background = /\b(white|light) background\b/i.test(text) ? 'light' : /\b(black|dark) background\b/i.test(text) ? 'dark' : 'auto';
      return { requests: [{ url: '/api/3d', body: { method: 'photos', sizeMm, views, quality, background } }] };
    }
    if (!text) return { error: 'Describe the part (with its sizes), or drop front, side and top pictures of it.' };
    if (wantsSweep(text, ctx)) return { requests: [{ url: '/api/3d', body: { method: 'sweep', prompt: text, sizeMm, imageModelId: ctx.imageModelId, modelId: ctx.llmId } }] };
    if (!ctx.llmId) return { error: 'Add a chat model first (Settings > Models).' };
    return { requests: [{ url: '/api/3d', body: { method: 'scad', prompt: text, sizeMm, modelId: ctx.llmId, thinking: true, baseJob: ctx.base || undefined } }] };
  }

  return { error: 'This mode does not take files.' };
}
